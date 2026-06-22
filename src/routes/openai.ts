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
import { HTTPException } from "hono/http-exception";
import type { Env } from "../config";
import { loadConfig, FALLBACK_MODELS } from "../config";
import { authenticate } from "../auth/middleware";
import { getPassthroughSession } from "../auth/passthroughSession";
import {
  chatCompletionRequestSchema,
  type ChatCompletionRequest,
} from "../models/openai";
import { buildOpenAIKiroPayload } from "../converters/openai";
import { buildToolNameReverseMap } from "../converters/core";
import { generateConversationId } from "../lib/utils";
import { ModelInfoCache } from "../lib/cache";
import { requestWithRetry } from "../lib/httpClient";
import { FirstTokenTimeoutError } from "../streaming/core";
import { streamKiroToOpenAI, collectOpenAIResponse } from "../streaming/openai";
import {
  getToolTruncation,
  getContentTruncation,
  generateTruncationToolResult,
  generateTruncationUserMessage,
} from "../lib/truncation";

export const openaiRoutes = new Hono<{ Bindings: Env }>();

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
openaiRoutes.get("/v1/models", async (c) => {
  const config = loadConfig(c.env);
  const auth = authenticate(c, false, config.proxyApiKey);

  let modelIds: string[];
  if (auth.isPassthrough) {
    const session = await getPassthroughSession(auth.token, config.apiRegion);
    modelIds = session.modelIds ?? FALLBACK_MODELS.map((m) => m.modelId);
  } else {
    modelIds = FALLBACK_MODELS.map((m) => m.modelId);
  }

  return c.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "anthropic",
      description: "Claude model via Kiro API",
    })),
  });
});

// POST /v1/chat/completions
openaiRoutes.post("/v1/chat/completions", async (c) => {
  const config = loadConfig(c.env);
  const auth = authenticate(c, false, config.proxyApiKey);

  // Only passthrough is supported by this gateway.
  if (!auth.isPassthrough) {
    throw new HTTPException(401, {
      message: "Provide a Kiro API key (ksk_*) as the Bearer token.",
    });
  }

  const raw = await c.req.json();
  const parsed = chatCompletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.issues }, 422);
  }
  const requestData = parsed.data as ChatCompletionRequest;

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

  const session = await getPassthroughSession(auth.token, config.apiRegion);
  const authContext = session.authContext;
  const modelCache = new ModelInfoCache(config.modelCacheTtlMs);

  const conversationId = generateConversationId();
  const { payload } = await buildOpenAIKiroPayload(
    requestData,
    conversationId,
    "",
    config,
  );
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

  const initial = await doFetch();
  if (initial.status !== 200) {
    const errorText = await initial.text();
    throw new HTTPException(initial.status as any, {
      message: `Upstream API error: ${errorText}`,
    });
  }

  if (requestData.stream) {
    // Stream with first-token retry: retry only before any byte is emitted.
    const encoder = new TextEncoder();
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
            })) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
            return;
          } catch (e) {
            if (e instanceof FirstTokenTimeoutError && attempt < config.firstTokenMaxRetries - 1) {
              const retry = await doFetch();
              if (retry.status !== 200) {
                controller.error(new Error(`Upstream error ${retry.status}`));
                return;
              }
              response = retry;
              continue;
            }
            controller.error(e);
            return;
          }
        }
        controller.error(
          new Error(`Model did not respond after ${config.firstTokenMaxRetries} attempts`),
        );
      },
      cancel() {
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
  });
  return c.json(openaiResponse);
});
