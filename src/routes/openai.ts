/**
 * OpenAI-compatible routes: /v1/models and /v1/chat/completions.
 * Port of the passthrough path of `routes_openai.py`.
 *
 * Flow: authenticate (ksk_) → truncation-recovery preprocess → web_search
 * auto-inject (Path B) → build Kiro payload → fetch upstream → stream or
 * collect → OpenAI response. First-token timeout triggers a re-fetch retry
 * before any bytes are sent to the client.
 */
import { Hono } from "hono";
import type { Env } from "../config";
import { loadConfig } from "../config";
import { authenticate } from "../auth/middleware";
import { getPassthroughSession } from "../auth/passthroughSession";
import {
  chatCompletionRequestSchema,
  type ChatCompletionRequest,
} from "../models/openai";
import { buildOpenAIKiroPayload } from "../converters/openai";
import { buildToolNameReverseMap } from "../converters/core";
import { generateConversationId } from "../lib/utils";
import {
  resolveAvailableModelIds,
  toOpenAiModelList,
  toAnthropicModelList,
} from "../lib/modelList";
import { requestWithRetry } from "../lib/httpClient";
import { FirstTokenTimeoutError } from "../streaming/core";
import { streamKiroToOpenAI, collectOpenAIResponse } from "../streaming/openai";
import {
  getToolTruncation,
  getContentTruncation,
  generateTruncationToolResult,
  generateTruncationUserMessage,
} from "../lib/truncation";
import { enhanceKiroErrorText } from "../lib/errors";
import { PayloadTooLargeError } from "../lib/payloadGuards";
import { AuditLogger } from "../lib/auditLog";

export const openaiRoutes = new Hono<{ Bindings: Env }>();

/**
 * OpenAI-shaped error body. The OpenAI SDK parses `{error:{message,type,code}}`
 * to surface a useful error; a plain-text body breaks that parsing (this is why
 * we don't let Hono's default HTTPException response through for API errors).
 */
function openaiError(message: string, type = "kiro_api_error", code: number | string | null = null) {
  return { error: { message, type, code, param: null } };
}

/** Serialize an object as a single OpenAI SSE `data:` frame. */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * 422 validation-error body, mirroring Python's `sanitize_validation_errors`:
 * the Zod issues plus a truncated echo of the raw request body.
 */
function validationError(issues: unknown, raw: unknown) {
  let body = "";
  try {
    body = (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 500);
  } catch {
    body = "";
  }
  return { detail: issues, body };
}

/** Collect tool names from an OpenAI request (standard + flat shapes). */
function openaiToolNames(tools: any[] | null | undefined): string[] {
  if (!tools) return [];
  const names: string[] = [];
  for (const t of tools) {
    const n = t?.function?.name ?? t?.name;
    if (n) names.push(n);
  }
  return names;
}

/** Apply truncation-recovery rewrites to the request messages (in place-ish). */
async function applyTruncationRecovery(
  messages: any[],
): Promise<any[]> {
  const modified: any[] = [];
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      const info = getToolTruncation(msg.tool_call_id);
      if (info) {
        const synthetic = generateTruncationToolResult(info.toolName, msg.tool_call_id);
        modified.push({
          ...msg,
          content: `${synthetic["content"]}\n\n---\n\nOriginal tool result:\n${msg.content}`,
        });
        continue;
      }
    }
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content) {
      const info = await getContentTruncation(msg.content);
      if (info) {
        modified.push(msg);
        modified.push({ role: "user", content: generateTruncationUserMessage() });
        continue;
      }
    }
    modified.push(msg);
  }
  return modified;
}

const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use when you need up-to-date data from the internet.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
};

// GET /v1/models
//
// Serves both audiences off one path: OpenAI clients and Claude Code's gateway
// model discovery. The response shape is negotiated on `anthropic-version` —
// the header Claude Code already sends and OpenAI clients never do — because
// Hono gives the path to whichever router registers it first, so a second
// registration in anthropicRoutes would be dead code.
//
// `x-api-key` is accepted here (unlike the rest of the OpenAI surface): Claude
// Code's discovery sends exactly one credential header — bearer when
// ANTHROPIC_AUTH_TOKEN is set, x-api-key otherwise (including apiKeyHelper) —
// so a bearer-only gate 401s those setups, and discovery swallows the error and
// silently falls back to its cache.
openaiRoutes.get("/v1/models", async (c) => {
  const config = loadConfig(c.env);
  const auth = authenticate(c, true, config.proxyApiKey);

  // In passthrough mode the discovered list is resolved per key; otherwise
  // (proxy mode) resolveAvailableModelIds falls back to the static catalog.
  // Both paths apply the same alias/hidden policy (e.g. show auto-kiro, hide auto).
  const modelIds = await resolveAvailableModelIds(
    auth.isPassthrough ? auth.token : null,
    config,
  );

  // The body varies by request header, so say so: this stock deploy is not
  // edge-cached, but the README points ANTHROPIC_BASE_URL here and any
  // intermediary cache would otherwise serve one client the other's shape.
  c.header("Vary", "anthropic-version");

  if (c.req.header("anthropic-version")) {
    return c.json(toAnthropicModelList(modelIds, { discoveryPrefix: true }));
  }
  return c.json(toOpenAiModelList(modelIds));
});

// POST /v1/embeddings — explicitly unsupported. The Kiro backend has no
// embeddings capability, so rather than letting this fall through to a generic
// 404 (which an OpenAI client surfaces as a confusing "route not found"), we
// return a clear, OpenAI-shaped 501 so the SDK reports the real reason.
openaiRoutes.post("/v1/embeddings", (c) =>
  c.json(
    openaiError(
      "The /v1/embeddings endpoint is not supported by this gateway. The Kiro " +
        "backend provides chat/completions only.",
      "invalid_request_error",
      501,
    ),
    501,
  ),
);

// POST /v1/chat/completions
openaiRoutes.post("/v1/chat/completions", async (c) => {
  const config = loadConfig(c.env);
  const audit = new AuditLogger(config);
  const auth = authenticate(c, false, config.proxyApiKey);
  await audit.auth(auth.token, auth.isPassthrough ? "passthrough" : "proxy");

  // Only passthrough is supported by this gateway.
  if (!auth.isPassthrough) {
    audit.rejected(401, "non-passthrough token");
    return c.json(
      openaiError(
        "Provide a Kiro API key (ksk_*) as the Bearer token.",
        "authentication_error",
        401,
      ),
      401,
    );
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    audit.rejected(400, "invalid JSON body");
    return c.json(
      openaiError("Invalid JSON in request body.", "invalid_request_error", 400),
      400,
    );
  }
  const parsed = chatCompletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    audit.rejected(422, "schema validation failed");
    return c.json(validationError(parsed.error.issues, raw), 422);
  }
  const requestData = parsed.data as ChatCompletionRequest;
  audit.received("POST", "/v1/chat/completions", {
    model: requestData.model,
    stream: requestData.stream,
    messageCount: requestData.messages.length,
  });
  audit.requestBody(raw);

  // Reject parameters the Kiro backend genuinely cannot satisfy, rather than
  // accepting them and silently returning something different from what was
  // asked. n>1 would require N independent upstream generations (a real cost /
  // credit multiplier the caller hasn't opted into), and logprobs are never
  // exposed by the upstream model, so they cannot be produced at all.
  if (typeof requestData.n === "number" && requestData.n > 1) {
    audit.rejected(400, `unsupported n=${requestData.n}`);
    return c.json(
      openaiError(
        "This gateway supports only n=1; request multiple completions separately.",
        "invalid_request_error",
        400,
      ),
      400,
    );
  }
  if (requestData.logprobs === true) {
    audit.rejected(400, "unsupported logprobs");
    return c.json(
      openaiError(
        "logprobs are not supported: the upstream model does not expose token log probabilities.",
        "invalid_request_error",
        400,
      ),
      400,
    );
  }

  // Truncation recovery preprocessing.
  requestData.messages = (await applyTruncationRecovery(
    requestData.messages as any[],
  )) as typeof requestData.messages;

  // web_search auto-injection (Path B).
  if (config.webSearchEnabled) {
    const tools = (requestData.tools ?? []) as any[];
    const hasWs = tools.some(
      (t) => t?.type === "function" && t?.function?.name === "web_search",
    );
    if (!hasWs) tools.push(WEB_SEARCH_TOOL);
    requestData.tools = tools as typeof requestData.tools;
  }

  const session = await getPassthroughSession(auth.token, config.apiRegion, config.modelCacheTtlMs);
  const authContext = session.authContext;
  const modelCache = session.modelCache;

  const conversationId = generateConversationId();
  let payload: Record<string, any>;
  try {
    ({ payload } = await buildOpenAIKiroPayload(
      requestData,
      conversationId,
      "",
      config,
    ));
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      audit.rejected(413, "payload too large");
      return c.json(openaiError(e.message, "invalid_request_error", 413), 413);
    }
    audit.rejected(400, `payload build failed: ${String(e)}`);
    return c.json(
      openaiError("Request could not be processed.", "invalid_request_error", 400),
      400,
    );
  }
  audit.kiroPayload(payload);
  const toolNameMap = await buildToolNameReverseMap(
    openaiToolNames(requestData.tools as any[]),
  );

  const url = `${authContext.apiHost}/generateAssistantResponse`;
  const messagesForTokenizer = requestData.messages as any[];
  const toolsForTokenizer = (requestData.tools as any[]) ?? null;

  // Client-cancellation → upstream-abort wiring.
  const ac = new AbortController();

  const doFetch = () =>
    requestWithRetry(authContext, url, payload, {
      stream: true,
      maxRetries: config.firstTokenMaxRetries,
      signal: ac.signal,
    });

  audit.upstreamRequest(url, requestData.model, requestData.stream);
  const initial = await doFetch();
  audit.upstreamResponse(initial.status);
  if (initial.status !== 200) {
    const errorText = await initial.text();
    const enhanced = enhanceKiroErrorText(errorText);
    audit.error("upstream non-200", { status: initial.status, reason: enhanced.reason });
    return c.json(
      openaiError(`Upstream API error: ${enhanced.userMessage}`, "kiro_api_error", initial.status),
      initial.status as any,
    );
  }

  if (requestData.stream) {
    // Stream with first-token retry: retry only before any byte is emitted.
    const encoder = new TextEncoder();
    // Emit an OpenAI-style error as an SSE frame, then terminate the stream
    // cleanly with [DONE]. Using controller.error() instead would abort the
    // HTTP response mid-stream with no parseable error and no [DONE] sentinel,
    // which an OpenAI SDK surfaces as a generic "connection error" rather than
    // the actual upstream message. Mirrors the Anthropic route's error frame.
    const emitErrorAndClose = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      message: string,
      type: string,
      code: number | string | null,
    ) => {
      controller.enqueue(encoder.encode(sse(openaiError(message, type, code))));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let response = initial;
        for (let attempt = 0; attempt < config.firstTokenMaxRetries; attempt++) {
          try {
            for await (const chunk of streamKiroToOpenAI({
              body: response.body!,
              model: requestData.model,
              modelCache,
              auth: authContext,
              config,
              firstTokenTimeoutMs: config.firstTokenTimeoutMs,
              requestMessages: messagesForTokenizer,
              requestTools: toolsForTokenizer,
              toolNameMap,
              stop: requestData.stop,
              audit,
            })) {
              controller.enqueue(encoder.encode(chunk));
            }
            audit.completed({ mode: "stream" });
            controller.close();
            return;
          } catch (e) {
            if (e instanceof FirstTokenTimeoutError && attempt < config.firstTokenMaxRetries - 1) {
              audit.upstreamRetry(attempt + 1, config.firstTokenMaxRetries);
              // Cancel the timed-out upstream body before re-fetching so the
              // stale connection is released instead of dangling until GC. The
              // generator's finally already released the reader lock, so the
              // body is cancellable here.
              await response.body?.cancel().catch(() => {});
              const retry = await doFetch();
              audit.upstreamResponse(retry.status);
              if (retry.status !== 200) {
                audit.error("upstream retry non-200", { status: retry.status });
                emitErrorAndClose(
                  controller,
                  `Upstream API error ${retry.status}`,
                  "kiro_api_error",
                  retry.status,
                );
                return;
              }
              response = retry;
              continue;
            }
            audit.error("stream error", { message: e instanceof Error ? e.message : String(e) });
            emitErrorAndClose(
              controller,
              e instanceof Error ? e.message : String(e),
              e instanceof FirstTokenTimeoutError ? "timeout_error" : "kiro_api_error",
              null,
            );
            return;
          }
        }
        audit.error("first-token retries exhausted");
        emitErrorAndClose(
          controller,
          `Model did not respond after ${config.firstTokenMaxRetries} attempts`,
          "timeout_error",
          null,
        );
      },
      cancel() {
        audit.error("client cancelled");
        ac.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  // Non-streaming: collect the full response.
  const openaiResponse = await collectOpenAIResponse({
    body: initial.body!,
    model: requestData.model,
    modelCache,
    auth: authContext,
    config,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    requestMessages: messagesForTokenizer,
    requestTools: toolsForTokenizer,
    toolNameMap,
    stop: requestData.stop,
    audit,
  });
  audit.responseBody(openaiResponse);
  audit.completed({
    mode: "non-stream",
    finishReason: openaiResponse.choices?.[0]?.finish_reason,
    usage: openaiResponse.usage,
  });
  return c.json(openaiResponse);
});
