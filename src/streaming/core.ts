/**
 * Core streaming: parse the Kiro response stream into unified KiroEvents.
 * Faithful port of `streaming_core.py`, adapted to Web Streams.
 *
 * Workers differences vs the Python original:
 *  - Reads a ReadableStream<Uint8Array> reader instead of httpx aiter_bytes().
 *  - First-token timeout races reader.read() against a timer (no asyncio).
 *  - Client cancellation → upstream abort is wired by the caller via the
 *    AbortController passed to fetch (see the route handlers).
 */
import type { KiroEvent } from "../types";
import type { Config } from "../config";
import {
  AwsEventStreamParser,
  parseBracketToolCalls,
  deduplicateToolCalls,
  type ParsedToolCall,
} from "../parsers/eventStream";
import { ThinkingParser } from "../parsers/thinking";

/** Minimal cache contract needed for token math (full impl in lib/cache). */
export interface MaxInputTokensProvider {
  getMaxInputTokens(model: string): number;
}

/** Accumulated result of consuming a full stream. */
export interface StreamResult {
  content: string;
  thinkingContent: string;
  toolCalls: ParsedToolCall[];
  usage: unknown | null;
  contextUsagePercentage: number | null;
}

/** Raised when the first token doesn't arrive within the timeout. */
export class FirstTokenTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirstTokenTimeoutError";
  }
}

/** Read the next chunk, rejecting with FirstTokenTimeoutError after `timeoutMs`. */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new FirstTokenTimeoutError(`No response within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Parse a Kiro response body into unified KiroEvents.
 *
 * @param body   Upstream response body (ReadableStream of bytes).
 * @param config Resolved config (fake-reasoning mode, first-token timeout).
 * @param firstTokenTimeoutMs Override for the first-token timeout.
 * @param enableThinkingParser Whether to run the thinking FSM.
 * @param toolNameMap Optional {alias: original} map to restore tool names.
 */
export async function* parseKiroStream(
  body: ReadableStream<Uint8Array>,
  config: Config,
  firstTokenTimeoutMs: number,
  enableThinkingParser = true,
  toolNameMap?: Record<string, string>,
): AsyncGenerator<KiroEvent, void, unknown> {
  const parser = new AwsEventStreamParser(toolNameMap);

  let thinkingParser: ThinkingParser | null = null;
  if (config.fakeReasoningEnabled && enableThinkingParser) {
    thinkingParser = new ThinkingParser({ handlingMode: config.fakeReasoningHandling });
  }

  const reader = body.getReader();

  try {
    // First chunk with timeout.
    let first: ReadableStreamReadResult<Uint8Array>;
    try {
      first = await readWithTimeout(reader, firstTokenTimeoutMs);
    } catch (e) {
      if (e instanceof FirstTokenTimeoutError) throw e;
      throw e;
    }
    if (first.done) return; // empty response — normal

    yield* processChunk(parser, first.value, thinkingParser);

    // Remaining chunks (no per-chunk first-token timeout).
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* processChunk(parser, value, thinkingParser);
    }

    // Flush the event-stream decoder (handles trailing buffered bytes).
    for (const event of parser.flush()) {
      if (event.type === "content") {
        yield* emitContent(event.data, thinkingParser);
      } else if (event.type === "usage") {
        yield { type: "usage", usage: event.data as Record<string, unknown> };
      } else if (event.type === "context_usage") {
        yield { type: "context_usage", contextUsagePercentage: event.data };
      }
    }

    // Finalize thinking parser → flush remaining thinking/regular content.
    if (thinkingParser) {
      const fin = thinkingParser.finalize();
      if (fin.thinkingContent) {
        const processed = thinkingParser.processForOutput(
          fin.thinkingContent,
          fin.isFirstThinkingChunk,
          fin.isLastThinkingChunk,
        );
        if (processed) {
          yield {
            type: "thinking",
            thinkingContent: processed,
            isFirstThinkingChunk: fin.isFirstThinkingChunk,
            isLastThinkingChunk: fin.isLastThinkingChunk,
          };
        }
      }
      if (fin.regularContent) {
        yield { type: "content", content: fin.regularContent };
      }
    }

    // Emit accumulated tool calls.
    for (const tc of parser.getToolCalls()) {
      yield { type: "tool_use", toolUse: { name: tc.function.name, toolUseId: tc.id, arguments: tc.function.arguments } };
    }
  } finally {
    reader.releaseLock();
  }
}

/** Route a content string through the thinking parser (or pass through). */
function* emitContent(
  content: string,
  thinkingParser: ThinkingParser | null,
): Generator<KiroEvent, void, unknown> {
  if (!thinkingParser) {
    yield { type: "content", content };
    return;
  }
  const r = thinkingParser.feed(content);
  if (r.thinkingContent) {
    const processed = thinkingParser.processForOutput(
      r.thinkingContent,
      r.isFirstThinkingChunk,
      r.isLastThinkingChunk,
    );
    if (processed) {
      yield {
        type: "thinking",
        thinkingContent: processed,
        isFirstThinkingChunk: r.isFirstThinkingChunk,
        isLastThinkingChunk: r.isLastThinkingChunk,
      };
    }
  }
  if (r.regularContent) {
    yield { type: "content", content: r.regularContent };
  }
}

/** Feed one raw chunk through the parser and yield resulting KiroEvents. */
function* processChunk(
  parser: AwsEventStreamParser,
  chunk: Uint8Array,
  thinkingParser: ThinkingParser | null,
): Generator<KiroEvent, void, unknown> {
  for (const event of parser.feed(chunk)) {
    if (event.type === "content") {
      yield* emitContent(event.data, thinkingParser);
    } else if (event.type === "usage") {
      yield { type: "usage", usage: event.data as Record<string, unknown> };
    } else if (event.type === "context_usage") {
      yield { type: "context_usage", contextUsagePercentage: event.data };
    }
  }
}

/**
 * Consume an entire stream into a {@link StreamResult}, including bracket-style
 * tool-call recovery from the full text. Mirrors `collect_stream_to_result`.
 */
export async function collectStreamToResult(
  body: ReadableStream<Uint8Array>,
  config: Config,
  firstTokenTimeoutMs: number,
  enableThinkingParser = true,
  toolNameMap?: Record<string, string>,
): Promise<StreamResult> {
  const result: StreamResult = {
    content: "",
    thinkingContent: "",
    toolCalls: [],
    usage: null,
    contextUsagePercentage: null,
  };
  let fullForBracket = "";

  for await (const event of parseKiroStream(
    body,
    config,
    firstTokenTimeoutMs,
    enableThinkingParser,
    toolNameMap,
  )) {
    if (event.type === "content" && event.content) {
      result.content += event.content;
      fullForBracket += event.content;
    } else if (event.type === "thinking" && event.thinkingContent) {
      result.thinkingContent += event.thinkingContent;
      fullForBracket += event.thinkingContent;
    } else if (event.type === "tool_use" && event.toolUse) {
      result.toolCalls.push({
        id: event.toolUse.toolUseId,
        type: "function",
        function: { name: event.toolUse.name, arguments: event.toolUse.arguments },
      });
    } else if (event.type === "usage" && event.usage) {
      result.usage = event.usage;
    } else if (event.type === "context_usage" && event.contextUsagePercentage != null) {
      result.contextUsagePercentage = event.contextUsagePercentage;
    }
  }

  // Recover bracket-style tool calls from accumulated text.
  const bracketCalls = parseBracketToolCalls(fullForBracket);
  if (bracketCalls.length) {
    if (toolNameMap) {
      for (const tc of bracketCalls) {
        const orig = toolNameMap[tc.function.name];
        if (orig) tc.function.name = orig;
      }
    }
    result.toolCalls = deduplicateToolCalls([...result.toolCalls, ...bracketCalls]);
  }

  return result;
}

/**
 * Derive token counts from Kiro's context-usage percentage.
 * Returns [promptTokens, totalTokens, promptSource, totalSource].
 * Mirrors `calculate_tokens_from_context_usage`.
 */
export function calculateTokensFromContextUsage(
  contextUsagePercentage: number | null,
  completionTokens: number,
  modelCache: MaxInputTokensProvider,
  model: string,
): [number, number, string, string] {
  if (contextUsagePercentage != null && contextUsagePercentage > 0) {
    const maxInput = modelCache.getMaxInputTokens(model);
    const totalTokens = Math.floor((contextUsagePercentage / 100) * maxInput);
    const promptTokens = Math.max(0, totalTokens - completionTokens);
    return [promptTokens, totalTokens, "subtraction", "API Kiro"];
  }
  return [0, completionTokens, "unknown", "tiktoken"];
}
