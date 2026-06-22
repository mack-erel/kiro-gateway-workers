/**
 * Anthropic-compatible routes: /v1/messages and /v1/messages/count_tokens.
 * Port of the passthrough path of `routes_anthropic.py`.
 */
import { Hono } from "hono";
import type { Env } from "../config";
import { loadConfig } from "../config";
import { authenticate } from "../auth/middleware";
import { getPassthroughSession } from "../auth/passthroughSession";
import {
  anthropicMessagesRequestSchema,
  anthropicCountTokensRequestSchema,
  type AnthropicMessagesRequest,
} from "../models/anthropic";
import { anthropicToKiro } from "../converters/anthropic";
import { buildToolNameReverseMap } from "../converters/core";
import { generateConversationId } from "../lib/utils";
import { ModelInfoCache } from "../lib/cache";
import { estimateRequestTokens } from "../lib/tokenizer";
import { requestWithRetry } from "../lib/httpClient";
import { FirstTokenTimeoutError } from "../streaming/core";
import {
  streamKiroToAnthropic,
  collectAnthropicResponse,
  formatSseEvent,
} from "../streaming/anthropic";
import {
  getToolTruncation,
  getContentTruncation,
  generateTruncationToolResult,
  generateTruncationUserMessage,
} from "../lib/truncation";
import { enhanceKiroErrorText } from "../lib/errors";

export const anthropicRoutes = new Hono<{ Bindings: Env }>();

/** Anthropic error JSON body. */
function anthropicError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the web for current information. Use when you need up-to-date data from the internet.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
};

/** Truncation-recovery preprocessing for Anthropic messages. */
async function applyTruncationRecovery(messages: any[]): Promise<any[]> {
  const modified: any[] = [];
  for (const msg of messages) {
    // user message with tool_result blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let changed = false;
      const blocks: any[] = [];
      for (const block of msg.content) {
        if (block?.type === "tool_result" && block?.tool_use_id) {
          const info = getToolTruncation(block.tool_use_id);
          if (info) {
            const synthetic = generateTruncationToolResult(info.toolName, block.tool_use_id);
            blocks.push({
              ...block,
              content: `${synthetic["content"]}\n\n---\n\nOriginal tool result:\n${block.content ?? ""}`,
            });
            changed = true;
            continue;
          }
        }
        blocks.push(block);
      }
      if (changed) {
        modified.push({ ...msg, content: blocks });
        continue;
      }
    }

    // assistant message with truncated text content
    if (msg.role === "assistant" && msg.content) {
      let text = "";
      if (typeof msg.content === "string") text = msg.content;
      else if (Array.isArray(msg.content)) {
        for (const b of msg.content) if (b?.type === "text") text += b.text ?? "";
      }
      if (text) {
        const info = await getContentTruncation(text);
        if (info) {
          modified.push(msg);
          modified.push({
            role: "user",
            content: [{ type: "text", text: generateTruncationUserMessage() }],
          });
          continue;
        }
      }
    }

    modified.push(msg);
  }
  return modified;
}

// POST /v1/messages
anthropicRoutes.post("/v1/messages", async (c) => {
  const config = loadConfig(c.env);
  const auth = authenticate(c, true, config.proxyApiKey);

  if (!auth.isPassthrough) {
    return c.json(
      anthropicError(
        "authentication_error",
        "Provide a Kiro API key (ksk_*) via x-api-key or Authorization: Bearer.",
      ),
      401,
    );
  }

  const raw = await c.req.json();
  const parsed = anthropicMessagesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.issues }, 422);
  }
  const requestData = parsed.data as AnthropicMessagesRequest;

  requestData.messages = (await applyTruncationRecovery(
    requestData.messages as any[],
  )) as typeof requestData.messages;

  // web_search auto-injection (Path B).
  if (config.webSearchEnabled) {
    const tools = (requestData.tools ?? []) as any[];
    if (!tools.some((t) => t?.name === "web_search")) tools.push(WEB_SEARCH_TOOL);
    requestData.tools = tools as typeof requestData.tools;
  }

  const session = await getPassthroughSession(auth.token, config.apiRegion);
  const authContext = session.authContext;
  const modelCache = new ModelInfoCache(config.modelCacheTtlMs);

  const conversationId = generateConversationId();
  let payload: Record<string, any>;
  try {
    ({ payload } = await anthropicToKiro(requestData, conversationId, "", config));
  } catch (e) {
    return c.json(anthropicError("invalid_request_error", String(e)), 400);
  }
  const toolNameMap = requestData.tools
    ? await buildToolNameReverseMap((requestData.tools as any[]).map((t) => t.name))
    : undefined;

  const url = `${authContext.apiHost}/generateAssistantResponse`;
  const messagesForTokenizer = requestData.messages as any[];
  const toolsForTokenizer = (requestData.tools as any[]) ?? null;
  const systemForTokenizer = requestData.system ?? null;

  const ac = new AbortController();
  const doFetch = () =>
    requestWithRetry(authContext, url, payload, {
      stream: true,
      maxRetries: config.firstTokenMaxRetries,
      signal: ac.signal,
    });

  const initial = await doFetch();
  if (initial.status !== 200) {
    const errorText = await initial.text();
    const enhanced = enhanceKiroErrorText(errorText);
    return c.json(anthropicError("api_error", enhanced.userMessage), initial.status as any);
  }

  const streamArgs = {
    model: requestData.model,
    modelCache,
    auth: authContext,
    config,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    requestMessages: messagesForTokenizer,
    requestTools: toolsForTokenizer,
    requestSystem: systemForTokenizer,
    toolNameMap,
  };

  if (requestData.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let response = initial;
        for (let attempt = 0; attempt < config.firstTokenMaxRetries; attempt++) {
          try {
            for await (const chunk of streamKiroToAnthropic({
              ...streamArgs,
              body: response.body!,
            })) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
            return;
          } catch (e) {
            if (e instanceof FirstTokenTimeoutError && attempt < config.firstTokenMaxRetries - 1) {
              const retry = await doFetch();
              if (retry.status !== 200) {
                controller.enqueue(
                  encoder.encode(
                    formatSseEvent("error", anthropicError("api_error", `Upstream error ${retry.status}`)),
                  ),
                );
                controller.close();
                return;
              }
              response = retry;
              continue;
            }
            // Emit an Anthropic error event before closing.
            controller.enqueue(
              encoder.encode(
                formatSseEvent(
                  "error",
                  anthropicError(
                    e instanceof FirstTokenTimeoutError ? "timeout_error" : "api_error",
                    e instanceof Error ? e.message : String(e),
                  ),
                ),
              ),
            );
            controller.close();
            return;
          }
        }
      },
      cancel() {
        ac.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  const anthropicResponse = await collectAnthropicResponse({
    ...streamArgs,
    body: initial.body!,
  });
  return c.json(anthropicResponse);
});

// POST /v1/messages/count_tokens — local estimate only, no upstream call.
anthropicRoutes.post("/v1/messages/count_tokens", async (c) => {
  const config = loadConfig(c.env);
  authenticate(c, true, config.proxyApiKey);

  const raw = await c.req.json();
  const parsed = anthropicCountTokensRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.issues }, 422);
  }
  const requestData = parsed.data;

  const estimate = estimateRequestTokens(
    requestData.messages as any[],
    (requestData.tools as any[]) ?? null,
    requestData.system ?? null,
    true, // Claude correction enabled (matches Python count_tokens endpoint)
  );

  return c.json({ input_tokens: estimate.totalTokens });
});
