/**
 * OpenAI streaming adapter: convert unified KiroEvents → OpenAI SSE chunks.
 * Port of `streaming_openai.py` (stream + collect), adapted to Web Streams.
 *
 * The first-token-retry wrapper from the Python original lives at the route
 * level here, since retrying means re-issuing the upstream fetch.
 */
import type { Config } from "../config";
import {
  parseKiroStream,
  type MaxInputTokensProvider,
  calculateTokensFromContextUsage,
} from "./core";
import {
  parseBracketToolCalls,
  deduplicateToolCalls,
  type ParsedToolCall,
} from "../parsers/eventStream";
import { generateCompletionId } from "../lib/utils";
import {
  countTokens,
  countMessageTokens,
  countToolsTokens,
} from "../lib/tokenizer";
import {
  callKiroMcpApi,
  generateSearchSummary,
} from "../lib/mcpTools";
import {
  saveToolTruncation,
  saveContentTruncation,
} from "../lib/truncation";
import {
  normalizeStopSequences,
  StopSequenceMatcher,
} from "../lib/stopSequences";
import type { KiroAuthContext } from "../types";
import type { AuditLogger } from "../lib/auditLog";

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

export interface OpenAIStreamArgs {
  body: ReadableStream<Uint8Array>;
  model: string;
  modelCache: MaxInputTokensProvider;
  auth: KiroAuthContext;
  config: Config;
  firstTokenTimeoutMs: number;
  requestMessages?: Record<string, any>[] | null;
  requestTools?: Record<string, any>[] | null;
  toolNameMap?: Record<string, string>;
  /** OpenAI `stop` — honored by truncating output at the first match. */
  stop?: string | string[] | null;
  audit?: AuditLogger;
}

/**
 * Stream Kiro → OpenAI SSE. Yields `data: {...}` lines ending with
 * `data: [DONE]`. Raises FirstTokenTimeoutError (from parseKiroStream) if the
 * first token never arrives — the route wrapper handles retry.
 */
export async function* streamKiroToOpenAI(
  args: OpenAIStreamArgs,
): AsyncGenerator<string, void, unknown> {
  const { body, model, modelCache, auth, config, firstTokenTimeoutMs } = args;
  const completionId = generateCompletionId();
  const created = Math.floor(Date.now() / 1000);
  let firstChunk = true;

  let meteringData: unknown = null;
  let contextUsagePercentage: number | null = null;
  let fullContent = "";
  let fullThinking = "";
  const toolCallsFromStream: ParsedToolCall[] = [];

  // Stop-sequence handling. Kiro has no native stop concept, so we truncate
  // streamed content at the first match. The matcher holds back any trailing
  // slice that could still grow into a stop sequence across chunk boundaries.
  const stopMatcher = new StopSequenceMatcher(normalizeStopSequences(args.stop));
  let stopTriggered = false;

  const chunk = (delta: Record<string, any>): string => {
    if (firstChunk) {
      delta = { role: "assistant", ...delta };
      firstChunk = false;
    }
    return sse({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
  };

  for await (const event of parseKiroStream(
    body,
    config,
    firstTokenTimeoutMs,
    true,
    args.toolNameMap,
    args.audit,
  )) {
    if (event.type === "content" && event.content) {
      // Route content through the stop matcher: emit only the provably-safe
      // prefix, hold back a possible partial match, and cut off at a full match.
      const r = stopMatcher.push(event.content);
      if (r.emit) {
        fullContent += r.emit;
        yield chunk({ content: r.emit });
      }
      if (r.stopped) {
        stopTriggered = true;
        break;
      }
    } else if (event.type === "thinking" && event.thinkingContent) {
      fullThinking += event.thinkingContent;
      const delta =
        config.fakeReasoningHandling === "as_reasoning_content"
          ? { reasoning_content: event.thinkingContent }
          : { content: event.thinkingContent };
      yield chunk(delta);
    } else if (event.type === "tool_use" && event.toolUse) {
      const toolName = event.toolUse.name;

      // Path B: intercept web_search → call MCP, emit summary as content.
      if (toolName === "web_search" && config.webSearchEnabled) {
        let toolInput: Record<string, any> = {};
        try {
          toolInput = event.toolUse.arguments ? JSON.parse(event.toolUse.arguments) : {};
        } catch {
          toolInput = {};
        }
        const query = toolInput["query"] ?? "";
        if (query) {
          const { results } = await callKiroMcpApi(query, auth);
          if (results !== null) {
            const summary = generateSearchSummary(query, results);
            for (let i = 0; i < summary.length; i += 100) {
              yield chunk({ content: summary.slice(i, i + 100) });
            }
            fullContent += summary;
            continue;
          }
        }
      }

      toolCallsFromStream.push({
        id: event.toolUse.toolUseId,
        type: "function",
        function: { name: event.toolUse.name, arguments: event.toolUse.arguments },
        _truncationDetected: event.toolUse.truncationDetected,
        _truncationInfo: event.toolUse.truncationInfo,
      });
    } else if (event.type === "usage" && event.usage) {
      meteringData = event.usage;
    } else if (event.type === "context_usage" && event.contextUsagePercentage != null) {
      contextUsagePercentage = event.contextUsagePercentage;
    }
  }

  // Stream ended without hitting a stop sequence: release any held-back tail.
  if (!stopTriggered) {
    const tail = stopMatcher.flush();
    if (tail) {
      fullContent += tail;
      yield chunk({ content: tail });
    }
  }

  // Truncation detection (missing completion signals).
  const streamCompletedNormally = meteringData != null || contextUsagePercentage != null;
  // When a stop sequence fired, generation ended deliberately mid-content — do
  // not re-interpret the partial text as bracket tool calls.
  const bracketCalls = stopTriggered ? [] : parseBracketToolCalls(fullContent);
  let allToolCalls = stopTriggered
    ? []
    : deduplicateToolCalls([...toolCallsFromStream, ...bracketCalls]);
  const contentWasTruncated =
    !stopTriggered &&
    !streamCompletedNormally &&
    fullContent.length > 0 &&
    allToolCalls.length === 0;

  // finish_reason: stop sequence > length (truncation) > tool_calls > stop.
  const finishReason = stopTriggered
    ? "stop"
    : contentWasTruncated
      ? "length"
      : allToolCalls.length
        ? "tool_calls"
        : "stop";

  // Token counting.
  const completionTokens = countTokens(fullContent + fullThinking);
  let [promptTokens, totalTokens, promptSource] = calculateTokensFromContextUsage(
    contextUsagePercentage,
    completionTokens,
    modelCache,
    model,
  );
  if (promptSource === "unknown" && args.requestMessages) {
    promptTokens = countMessageTokens(args.requestMessages, false);
    if (args.requestTools) promptTokens += countToolsTokens(args.requestTools, false);
    totalTokens = promptTokens + completionTokens;
  }

  // Emit tool_calls chunk (with index).
  if (allToolCalls.length) {
    const indexed = allToolCalls.map((tc, idx) => ({
      index: idx,
      id: tc.id,
      type: tc.type ?? "function",
      function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "{}" },
    }));
    yield sse({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { tool_calls: indexed }, finish_reason: null }],
    });
  }

  // Persist truncation info for recovery on the next request.
  if (config.truncationRecovery) {
    for (const tc of allToolCalls) {
      if (tc._truncationDetected && tc._truncationInfo) {
        saveToolTruncation(tc.id, tc.function.name, tc._truncationInfo);
      }
    }
    if (contentWasTruncated) await saveContentTruncation(fullContent);
  }

  // Final chunk with usage.
  const usage: Record<string, any> = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
  if (meteringData) usage["credits_used"] = meteringData;

  yield sse({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage,
  });
  yield "data: [DONE]\n\n";
}

/**
 * Collect a full (non-streaming) OpenAI chat.completion response by consuming
 * the SSE generator. Mirrors `collect_stream_response`.
 */
export async function collectOpenAIResponse(
  args: OpenAIStreamArgs,
): Promise<Record<string, any>> {
  let fullContent = "";
  let fullReasoning = "";
  let finalUsage: Record<string, any> | null = null;
  const toolCalls: Record<string, any>[] = [];
  let finishReason = "stop";
  const completionId = generateCompletionId();

  for await (const chunkStr of streamKiroToOpenAI(args)) {
    if (!chunkStr.startsWith("data:")) continue;
    const dataStr = chunkStr.slice("data:".length).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    let data: Record<string, any>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      continue;
    }

    const delta = data["choices"]?.[0]?.["delta"] ?? {};
    if ("content" in delta && delta["content"]) fullContent += delta["content"];
    if ("reasoning_content" in delta && delta["reasoning_content"]) {
      fullReasoning += delta["reasoning_content"];
    }
    if ("tool_calls" in delta) toolCalls.push(...delta["tool_calls"]);

    const fr = data["choices"]?.[0]?.["finish_reason"];
    if (fr) finishReason = fr;
    if ("usage" in data) finalUsage = data["usage"];
  }

  const message: Record<string, any> = { role: "assistant", content: fullContent };
  if (fullReasoning) message["reasoning_content"] = fullReasoning;
  if (toolCalls.length) {
    message["tool_calls"] = toolCalls.map((tc) => ({
      id: tc["id"],
      type: tc["type"] ?? "function",
      function: {
        name: tc["function"]?.["name"] ?? "",
        arguments: tc["function"]?.["arguments"] ?? "{}",
      },
    }));
  }

  return {
    id: completionId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: finalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
