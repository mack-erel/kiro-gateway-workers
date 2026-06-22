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
import type { AuditLogger } from "../lib/auditLog";

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

/**
 * Raised when a mid-stream chunk stalls beyond STREAMING_READ_TIMEOUT.
 * Mirrors httpx's read-timeout on `aiter_bytes` in the Python original — a
 * wedged upstream connection must surface rather than hang the invocation.
 */
export class StreamReadTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamReadTimeoutError";
  }
}

/**
 * Read the next chunk, rejecting after `timeoutMs`. `makeError` builds the
 * rejection so the first-token read and inter-chunk reads can raise distinct
 * error types while sharing the race logic.
 */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  makeError: (ms: number) => Error,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError(timeoutMs)), timeoutMs);
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
 * @param audit Optional audit logger; each KiroEvent is logged (Level 2).
 */
export async function* parseKiroStream(
  body: ReadableStream<Uint8Array>,
  config: Config,
  firstTokenTimeoutMs: number,
  enableThinkingParser = true,
  toolNameMap?: Record<string, string>,
  audit?: AuditLogger,
): AsyncGenerator<KiroEvent, void, unknown> {
  for await (const event of parseKiroStreamRaw(
    body,
    config,
    firstTokenTimeoutMs,
    enableThinkingParser,
    toolNameMap,
  )) {
    // Single choke point for Level-2 audit logging — every event passes here.
    if (audit) audit.streamEvent(event.type, summarizeEvent(event));
    yield event;
  }
}

/** Compact, body-free summary of a KiroEvent for the audit log. */
function summarizeEvent(event: KiroEvent): Record<string, unknown> {
  switch (event.type) {
    case "content":
      return { chars: event.content?.length ?? 0 };
    case "thinking":
      return { chars: event.thinkingContent?.length ?? 0 };
    case "tool_use":
      return { tool: event.toolUse?.name, argChars: event.toolUse?.arguments.length ?? 0 };
    case "context_usage":
      return { percentage: event.contextUsagePercentage };
    case "usage":
      return { usage: event.usage };
    default:
      return {};
  }
}

async function* parseKiroStreamRaw(
  body: ReadableStream<Uint8Array>,
  config: Config,
  firstTokenTimeoutMs: number,
  enableThinkingParser = true,
  toolNameMap?: Record<string, string>,
): AsyncGenerator<KiroEvent, void, unknown> {
  const parser = new AwsEventStreamParser(toolNameMap);

  let thinkingParser: ThinkingParser | null = null;
  if (config.fakeReasoningEnabled && enableThinkingParser) {
    thinkingParser = new ThinkingParser({
      handlingMode: config.fakeReasoningHandling,
      initialBufferSize: config.fakeReasoningInitialBufferSize,
    });
  }

  const reader = body.getReader();
  const readTimeoutMs = config.streamingReadTimeoutMs;

  try {
    // First chunk with the (shorter) first-token timeout.
    const first = await readWithTimeout(
      reader,
      firstTokenTimeoutMs,
      (ms) => new FirstTokenTimeoutError(`No response within ${ms}ms`),
    );
    if (first.done) return; // empty response — normal

    yield* processChunk(parser, first.value, thinkingParser);

    // Remaining chunks: enforce the inter-chunk read timeout so a stream that
    // goes silent mid-flight aborts instead of hanging the invocation.
    for (;;) {
      const { done, value } = await readWithTimeout(
        reader,
        readTimeoutMs,
        (ms) => new StreamReadTimeoutError(`Stream stalled: no data within ${ms}ms`),
      );
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

    // Emit accumulated tool calls, preserving truncation flags so the
    // downstream adapters can persist recovery state.
    for (const tc of parser.getToolCalls()) {
      yield {
        type: "tool_use",
        toolUse: {
          name: tc.function.name,
          toolUseId: tc.id,
          arguments: tc.function.arguments,
          truncationDetected: tc._truncationDetected,
          truncationInfo: tc._truncationInfo,
        },
      };
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
  audit?: AuditLogger,
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
    audit,
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
        _truncationDetected: event.toolUse.truncationDetected,
        _truncationInfo: event.toolUse.truncationInfo,
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
