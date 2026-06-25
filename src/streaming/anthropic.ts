/**
 * Anthropic streaming adapter: convert unified KiroEvents → Anthropic Messages
 * SSE. Port of `streaming_anthropic.py` adapted to Web Streams.
 *
 * SSE sequence: message_start → [thinking block] → [text block] → [tool_use
 * blocks] → message_delta → message_stop. The first-token-retry wrapper lives
 * at the route level (retry = re-fetch upstream).
 */
import type { Config } from "../config";
import type { KiroAuthContext } from "../types";
import {
  parseKiroStream,
  collectStreamToResult,
  type MaxInputTokensProvider,
  calculateTokensFromContextUsage,
} from "./core";
import { countTokens, estimateRequestTokens } from "../lib/tokenizer";
import { callKiroMcpApi, generateSearchSummary } from "../lib/mcpTools";
import { saveToolTruncation, saveContentTruncation } from "../lib/truncation";
import {
  normalizeStopSequences,
  StopSequenceMatcher,
  applyStopToText,
} from "../lib/stopSequences";
import type { AuditLogger } from "../lib/auditLog";

/** Anthropic SSE event line: `event: <type>\ndata: <json>\n\n`. */
export function formatSseEvent(eventType: string, data: Record<string, any>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function uuidHex(len: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, len);
}

export function generateMessageId(): string {
  return `msg_${uuidHex(24)}`;
}

function generateThinkingSignature(): string {
  return `sig_${uuidHex(32)}`;
}

/** Pull cache token fields out of upstream usage (snake or camel case). */
function extractCacheUsageFields(usage: unknown): Record<string, number> {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, any>;
  const out: Record<string, number> = {};
  const map: Record<string, string> = {
    cache_read_input_tokens: "cache_read_input_tokens",
    cacheReadInputTokens: "cache_read_input_tokens",
    cache_creation_input_tokens: "cache_creation_input_tokens",
    cacheCreationInputTokens: "cache_creation_input_tokens",
  };
  for (const [src, dst] of Object.entries(map)) {
    if (typeof u[src] === "number") out[dst] = Math.floor(u[src]);
  }
  return out;
}

export interface AnthropicStreamArgs {
  body: ReadableStream<Uint8Array>;
  model: string;
  modelCache: MaxInputTokensProvider;
  auth: KiroAuthContext;
  config: Config;
  firstTokenTimeoutMs: number;
  requestMessages?: Record<string, any>[] | null;
  requestTools?: Record<string, any>[] | null;
  requestSystem?: unknown;
  toolNameMap?: Record<string, string>;
  /** Anthropic `stop_sequences` — honored by truncating output at the first match. */
  stopSequences?: string[] | null;
  audit?: AuditLogger;
}

/** Build a web_search_result content list from MCP results. */
function buildSearchContent(results: Record<string, any>): Record<string, any>[] {
  return (results["results"] ?? []).map((r: Record<string, any>) => ({
    type: "web_search_result",
    title: r["title"] ?? "",
    url: r["url"] ?? "",
    encrypted_content: r["snippet"] ?? "",
    page_age: null,
  }));
}

/** Stream Kiro → Anthropic SSE. */
export async function* streamKiroToAnthropic(
  args: AnthropicStreamArgs,
): AsyncGenerator<string, void, unknown> {
  const { body, model, modelCache, auth, config, firstTokenTimeoutMs } = args;
  const messageId = generateMessageId();

  let inputTokens = 0;
  if (args.requestMessages || args.requestTools || args.requestSystem) {
    inputTokens = estimateRequestTokens(
      args.requestMessages ?? [],
      args.requestTools,
      args.requestSystem,
      false,
    ).totalTokens;
  }

  let fullContent = "";
  let fullThinking = "";

  let currentBlockIndex = 0;
  let thinkingBlockStarted = false;
  let thinkingBlockIndex: number | null = null;
  let textBlockStarted = false;
  let textBlockIndex: number | null = null;
  const toolBlocks: Record<string, any>[] = [];
  const thinkingSignature = generateThinkingSignature();

  let contextUsagePercentage: number | null = null;
  let upstreamCacheUsage: Record<string, number> = {};
  const truncatedTools: Array<{ id: string; name: string; info: Record<string, any> }> = [];

  // Stop-sequence handling (Anthropic stop_sequences). Truncate streamed text at
  // the first match; the matcher holds back any cross-chunk partial prefix.
  const stopMatcher = new StopSequenceMatcher(normalizeStopSequences(args.stopSequences));
  let stopTriggered = false;
  let matchedStopSequence: string | null = null;

  // message_start is emitted LAZILY, only after the first upstream event is
  // successfully read — never before. The first-token-timeout retry wrapper
  // (route level) re-invokes this generator from scratch when the very first
  // read times out; if we emitted message_start eagerly here, every retry would
  // produce a second message_start and violate the Anthropic SSE contract
  // (exactly one message_start per response). Gating it on the first event means
  // a timed-out attempt emits nothing, so the successful attempt is the only one
  // that opens the message.
  let messageStartEmitted = false;
  const messageStartEvent = () =>
    formatSseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });

  for await (const event of parseKiroStream(
    body,
    config,
    firstTokenTimeoutMs,
    true,
    args.toolNameMap,
    args.audit,
  )) {
    if (!messageStartEmitted) {
      messageStartEmitted = true;
      yield messageStartEvent();
    }
    if (event.type === "content") {
      const raw = event.content ?? "";
      // Route through the stop matcher: emit only the provably-safe prefix.
      const r = stopMatcher.push(raw);
      const content = r.emit;

      if (content && thinkingBlockStarted && thinkingBlockIndex !== null) {
        yield formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: thinkingBlockIndex,
        });
        thinkingBlockStarted = false;
        currentBlockIndex += 1;
      }
      if (content) {
        fullContent += content;
        if (!textBlockStarted) {
          textBlockIndex = currentBlockIndex;
          yield formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
          textBlockStarted = true;
        }
        yield formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: content },
        });
      }
      if (r.stopped) {
        stopTriggered = true;
        matchedStopSequence = r.matched;
        break;
      }
    } else if (event.type === "thinking") {
      const thinking = event.thinkingContent ?? "";
      fullThinking += thinking;

      if (config.fakeReasoningHandling === "as_reasoning_content") {
        if (!thinkingBlockStarted) {
          thinkingBlockIndex = currentBlockIndex;
          yield formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: thinkingBlockIndex,
            content_block: { type: "thinking", thinking: "", signature: thinkingSignature },
          });
          thinkingBlockStarted = true;
        }
        if (thinking) {
          yield formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: thinkingBlockIndex,
            delta: { type: "thinking_delta", thinking },
          });
        }
      } else if ((config.fakeReasoningHandling as string) === "include_as_text") {
        if (!textBlockStarted) {
          textBlockIndex = currentBlockIndex;
          yield formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
          textBlockStarted = true;
        }
        if (thinking) {
          yield formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: thinking },
          });
        }
      }
      // "strip"/"remove" modes: skip.
    } else if (event.type === "tool_use" && event.toolUse) {
      // Close open thinking/text blocks first.
      if (thinkingBlockStarted && thinkingBlockIndex !== null) {
        yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
        thinkingBlockStarted = false;
        currentBlockIndex += 1;
      }
      if (textBlockStarted && textBlockIndex !== null) {
        yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
        textBlockStarted = false;
        currentBlockIndex += 1;
      }

      const toolId = event.toolUse.toolUseId || `toolu_${uuidHex(24)}`;
      const toolName = event.toolUse.name;
      let toolInput: Record<string, any> = {};
      try {
        toolInput = event.toolUse.arguments ? JSON.parse(event.toolUse.arguments) : {};
      } catch {
        toolInput = {};
      }

      // Path B: web_search interception.
      if (toolName === "web_search" && config.webSearchEnabled) {
        const query = toolInput["query"] ?? "";
        if (!query) continue;
        const { toolUseId: mcpId, results } = await callKiroMcpApi(query, auth);
        if (results !== null) {
          const mcpToolId = mcpId ?? `srvtoolu_${uuidHex(32)}`;
          yield formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { id: mcpToolId, type: "server_tool_use", name: "web_search", input: {} },
          });
          yield formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: currentBlockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) },
          });
          yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
          currentBlockIndex += 1;

          yield formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: mcpToolId,
              content: buildSearchContent(results),
            },
          });
          yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
          currentBlockIndex += 1;

          yield formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "text", text: "" },
          });
          const summary = generateSearchSummary(query, results);
          // Count the streamed summary toward output tokens, matching the
          // OpenAI streaming path and the Anthropic collect path (which both
          // include it). Without this, outputTokens undercounts.
          fullContent += summary;
          for (let i = 0; i < summary.length; i += 100) {
            yield formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: currentBlockIndex,
              delta: { type: "text_delta", text: summary.slice(i, i + 100) },
            });
          }
          yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });
          currentBlockIndex += 1;
          continue;
        }
      }

      // Capture the truncation flag the parser attached so recovery state is
      // persisted after the stream completes (mirrors the Python collect path).
      if (event.toolUse.truncationDetected && event.toolUse.truncationInfo) {
        truncatedTools.push({
          id: toolId,
          name: toolName,
          info: event.toolUse.truncationInfo as unknown as Record<string, any>,
        });
      }
      yield formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: currentBlockIndex,
        content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
      });
      yield formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: currentBlockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) },
      });
      yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: currentBlockIndex });

      toolBlocks.push({ id: toolId, name: toolName, input: toolInput });
      currentBlockIndex += 1;
    } else if (event.type === "context_usage" && event.contextUsagePercentage != null) {
      contextUsagePercentage = event.contextUsagePercentage;
    } else if (event.type === "usage" && event.usage) {
      upstreamCacheUsage = { ...upstreamCacheUsage, ...extractCacheUsageFields(event.usage) };
    }
  }

  // Empty upstream stream (no events at all): message_start was never emitted,
  // but the contract still requires it before message_delta/message_stop. Flush
  // it now so the response is well-formed. (This path is reached only when the
  // first read succeeds with an immediate end-of-stream, not on a timeout — a
  // timeout throws and is retried before reaching here.)
  if (!messageStartEmitted) {
    messageStartEmitted = true;
    yield messageStartEvent();
  }

  // Stream ended without a stop match: release any held-back tail into the text
  // block (opening one if no content was emitted yet).
  if (!stopTriggered) {
    const tail = stopMatcher.flush();
    if (tail) {
      fullContent += tail;
      if (thinkingBlockStarted && thinkingBlockIndex !== null) {
        yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
        thinkingBlockStarted = false;
        currentBlockIndex += 1;
      }
      if (!textBlockStarted) {
        textBlockIndex = currentBlockIndex;
        yield formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" },
        });
        textBlockStarted = true;
      }
      yield formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: tail },
      });
    }
  }

  // Close any blocks still open.
  if (thinkingBlockStarted && thinkingBlockIndex !== null) {
    yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
    currentBlockIndex += 1;
  }
  if (textBlockStarted && textBlockIndex !== null) {
    yield formatSseEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
  }

  const streamCompletedNormally = contextUsagePercentage !== null;
  const contentWasTruncated =
    !stopTriggered &&
    !streamCompletedNormally &&
    fullContent.length > 0 &&
    toolBlocks.length === 0;

  let outputTokens = countTokens(fullContent + fullThinking);
  if (contextUsagePercentage !== null) {
    const [promptTokens, , promptSource] = calculateTokensFromContextUsage(
      contextUsagePercentage,
      outputTokens,
      modelCache,
      model,
    );
    if (promptSource !== "unknown") inputTokens = promptTokens;
  }

  // stop_reason: a matched stop sequence wins; report it (+ stop_sequence)
  // exactly as the Anthropic API does.
  const stopReason = stopTriggered
    ? "stop_sequence"
    : contentWasTruncated
      ? "max_tokens"
      : toolBlocks.length
        ? "tool_use"
        : "end_turn";

  yield formatSseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: stopTriggered ? matchedStopSequence : null },
    usage: { output_tokens: outputTokens, ...upstreamCacheUsage },
  });
  yield formatSseEvent("message_stop", { type: "message_stop" });

  if (config.truncationRecovery) {
    for (const t of truncatedTools) saveToolTruncation(t.id, t.name, t.info);
    if (contentWasTruncated) await saveContentTruncation(fullContent);
  }
}

/**
 * Collect a full (non-streaming) Anthropic Messages response. Mirrors
 * `collect_anthropic_response`.
 */
export async function collectAnthropicResponse(
  args: AnthropicStreamArgs,
): Promise<Record<string, any>> {
  const { model, modelCache, auth, config } = args;
  const messageId = generateMessageId();

  let inputTokens = 0;
  if (args.requestMessages || args.requestTools || args.requestSystem) {
    inputTokens = estimateRequestTokens(
      args.requestMessages ?? [],
      args.requestTools,
      args.requestSystem,
      false,
    ).totalTokens;
  }

  const result = await collectStreamToResult(
    args.body,
    config,
    args.firstTokenTimeoutMs,
    true,
    args.toolNameMap,
    args.audit,
  );
  const upstreamCacheUsage = extractCacheUsageFields(result.usage);

  const contentBlocks: Record<string, any>[] = [];
  if (result.thinkingContent && config.fakeReasoningHandling === "as_reasoning_content") {
    contentBlocks.push({
      type: "thinking",
      thinking: result.thinkingContent,
      signature: generateThinkingSignature(),
    });
  }

  // Apply stop_sequences to the generated content (mirrors the streaming path:
  // matched against content text, truncated before the sequence).
  const stopSeqs = normalizeStopSequences(args.stopSequences);
  const stopApplied = applyStopToText(result.content, stopSeqs);
  const stoppedBySequence = stopApplied.stopped;
  const effectiveContent = stopApplied.text;

  let textContent = effectiveContent;
  if (result.thinkingContent && (config.fakeReasoningHandling as string) === "include_as_text") {
    textContent = result.thinkingContent + textContent;
  }
  if (textContent) contentBlocks.push({ type: "text", text: textContent });

  // Tool calls: intercept web_search (Path B) so the non-streaming path returns
  // executed search results instead of an unresolved tool_use block — mirrors
  // the streaming adapter. Only real (non-web_search) tool calls drive
  // stop_reason: tool_use. Skipped entirely when a stop sequence fired — output
  // ended deliberately mid-content.
  let realToolUseCount = 0;
  let webSearchOutput = "";
  for (const tc of stoppedBySequence ? [] : result.toolCalls) {
    const toolName = tc.function.name;
    let input: Record<string, any> = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = {};
    }

    if (toolName === "web_search" && config.webSearchEnabled) {
      const query = input["query"] ?? "";
      if (query) {
        const { toolUseId: mcpId, results } = await callKiroMcpApi(query, auth);
        if (results !== null) {
          const mcpToolId = mcpId ?? `srvtoolu_${uuidHex(32)}`;
          contentBlocks.push({ id: mcpToolId, type: "server_tool_use", name: "web_search", input: { query } });
          contentBlocks.push({
            type: "web_search_tool_result",
            tool_use_id: mcpToolId,
            content: buildSearchContent(results),
          });
          const summary = generateSearchSummary(query, results);
          contentBlocks.push({ type: "text", text: summary });
          webSearchOutput += summary;
          continue;
        }
      }
    }

    const toolId = tc.id || `toolu_${uuidHex(24)}`;
    contentBlocks.push({ type: "tool_use", id: toolId, name: toolName, input });
    realToolUseCount += 1;
  }

  let outputTokens = countTokens(effectiveContent + result.thinkingContent + webSearchOutput);
  if (result.contextUsagePercentage !== null) {
    const [promptTokens, , promptSource] = calculateTokensFromContextUsage(
      result.contextUsagePercentage,
      outputTokens,
      modelCache,
      model,
    );
    if (promptSource !== "unknown") inputTokens = promptTokens;
  }

  const streamCompletedNormally = result.contextUsagePercentage !== null;
  const contentWasTruncated =
    !stoppedBySequence &&
    !streamCompletedNormally &&
    result.content.length > 0 &&
    result.toolCalls.length === 0;

  const stopReason = stoppedBySequence
    ? "stop_sequence"
    : contentWasTruncated
      ? "max_tokens"
      : realToolUseCount > 0
        ? "tool_use"
        : "end_turn";

  if (config.truncationRecovery) {
    for (const tc of result.toolCalls) {
      if (tc._truncationDetected && tc._truncationInfo) {
        saveToolTruncation(tc.id, tc.function.name, tc._truncationInfo);
      }
    }
    if (contentWasTruncated) await saveContentTruncation(result.content);
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model,
    stop_reason: stopReason,
    stop_sequence: stoppedBySequence ? stopApplied.matched : null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, ...upstreamCacheUsage },
  };
}
