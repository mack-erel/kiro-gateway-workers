/**
 * OpenAI → unified converter (adapter layer). Port of `converters_openai.py`.
 * Builds the Kiro payload from an OpenAI ChatCompletionRequest by translating
 * messages/tools to the unified format and delegating to converters/core.
 */
import type { Config } from "../config";
import { HIDDEN_MODELS } from "../config";
import type {
  ThinkingConfig,
  UnifiedMessage,
  UnifiedTool,
  UnifiedToolCall,
  UnifiedToolResult,
  UnifiedImage,
} from "../types";
import { getModelIdForKiro } from "../lib/modelResolver";
import { logWarn } from "../lib/log";
import {
  extractTextContent,
  extractImagesFromContent,
  buildKiroPayload,
  type KiroPayloadResult,
} from "./core";
import type { ChatMessage, ChatCompletionRequest, Tool } from "../models/openai";

/** Map extracted core images ({media_type,data}) to UnifiedImage. */
function toUnifiedImages(
  raw: Array<{ media_type: string; data: string }>,
): UnifiedImage[] | undefined {
  return raw.length ? raw.map((i) => ({ mediaType: i.media_type, data: i.data })) : undefined;
}

/** Extract tool_result blocks from an OpenAI user message content list. */
function extractToolResultsFromOpenAI(content: unknown): UnifiedToolResult[] {
  const results: UnifiedToolResult[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (item as any).type === "tool_result") {
        results.push({
          toolUseId: (item as any).tool_use_id ?? "",
          content: extractTextContent((item as any).content ?? "") || "(empty result)",
        });
      }
    }
  }
  return results;
}

/** Extract tool calls from an OpenAI assistant message. */
function extractToolCallsFromOpenAI(msg: ChatMessage): UnifiedToolCall[] {
  const toolCalls: UnifiedToolCall[] = [];
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc && typeof tc === "object") {
        toolCalls.push({
          id: (tc as any).id ?? "",
          name: (tc as any).function?.name ?? "",
          arguments: (tc as any).function?.arguments ?? "{}",
        });
      }
    }
  }
  return toolCalls;
}

/** Convert OpenAI messages to (systemPrompt, unifiedMessages). */
export function convertOpenAIMessagesToUnified(
  messages: ChatMessage[],
): [string, UnifiedMessage[]] {
  let systemPrompt = "";
  const nonSystem: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += extractTextContent(msg.content) + "\n";
    } else {
      nonSystem.push(msg);
    }
  }
  systemPrompt = systemPrompt.trim();

  const processed: UnifiedMessage[] = [];
  let pendingToolResults: UnifiedToolResult[] = [];
  let pendingToolImages: UnifiedImage[] = [];

  const flushPending = () => {
    if (pendingToolResults.length) {
      processed.push({
        role: "user",
        content: "",
        toolResults: [...pendingToolResults],
        images: pendingToolImages.length ? [...pendingToolImages] : undefined,
      });
      pendingToolResults = [];
      pendingToolImages = [];
    }
  };

  for (const msg of nonSystem) {
    if (msg.role === "tool") {
      pendingToolResults.push({
        toolUseId: msg.tool_call_id ?? "",
        content: extractTextContent(msg.content) || "(empty result)",
      });
      const imgs = toUnifiedImages(extractImagesFromContent(msg.content));
      if (imgs) pendingToolImages.push(...imgs);
    } else {
      flushPending();

      let toolCalls: UnifiedToolCall[] | undefined;
      let toolResults: UnifiedToolResult[] | undefined;
      let images: UnifiedImage[] | undefined;

      if (msg.role === "assistant") {
        const tc = extractToolCallsFromOpenAI(msg);
        toolCalls = tc.length ? tc : undefined;
      } else if (msg.role === "user") {
        const tr = extractToolResultsFromOpenAI(msg.content);
        toolResults = tr.length ? tr : undefined;
        images = toUnifiedImages(extractImagesFromContent(msg.content));
      }

      processed.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: extractTextContent(msg.content),
        toolCalls,
        toolResults,
        images,
      });
    }
  }
  flushPending();

  return [systemPrompt, processed];
}

/** Convert OpenAI tools (standard + flat) to unified tools. */
export function convertOpenAIToolsToUnified(
  tools: Tool[] | null | undefined,
): UnifiedTool[] | null {
  if (!tools || tools.length === 0) return null;

  const unified: UnifiedTool[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") {
      // Silently dropping a caller-supplied tool is a correctness gap: the
      // tokenizer still counts it and the client expects it to be available.
      // We can't translate non-function tools into Kiro's tool format, but we
      // log the drop so it's observable rather than invisible.
      logWarn("tool.dropped.nonfunction", {
        type: typeof tool.type === "string" ? tool.type : String(tool.type),
        name: (tool as any).name ?? (tool as any).function?.name ?? null,
      });
      continue;
    }
    if (tool.function) {
      unified.push({
        name: tool.function.name,
        description: tool.function.description ?? "",
        inputSchema: tool.function.parameters ?? {},
      });
    } else if (tool.name) {
      unified.push({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.input_schema ?? {},
      });
    }
  }
  return unified.length ? unified : null;
}

const EFFORT_PERCENT: Record<string, number> = {
  none: 0.0,
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
};

/** reasoning_effort → thinking budget (percentage of max_tokens). */
export function reasoningEffortToBudget(maxTokens: number, effort: string): number {
  return Math.floor(maxTokens * (EFFORT_PERCENT[effort] ?? 0));
}

/** Extract thinking config from an OpenAI request's reasoning_effort. */
export function extractThinkingConfigFromOpenAI(
  request: ChatCompletionRequest,
): ThinkingConfig {
  if (!request.reasoning_effort) {
    return { enabled: true, budgetTokens: null };
  }
  if (request.reasoning_effort === "none") {
    return { enabled: false, budgetTokens: null };
  }
  const maxTokens = request.max_tokens || request.max_completion_tokens || 4096;
  return {
    enabled: true,
    budgetTokens: reasoningEffortToBudget(maxTokens, request.reasoning_effort),
  };
}

/**
 * Build a best-effort system-prompt instruction for OpenAI `response_format`.
 * Kiro has no constrained/JSON decoding, so we steer the model with text. This
 * is not a guarantee — it mirrors how OpenAI's own json_object mode behaves when
 * the model is merely asked (vs. grammar-constrained). Returns "" for text mode
 * or when no response_format is set.
 */
export function buildResponseFormatInstruction(
  responseFormat: ChatCompletionRequest["response_format"],
): string {
  if (!responseFormat) return "";
  const type = (responseFormat as any).type;
  if (type === "json_object") {
    return (
      "\n\nYou must respond with a single valid JSON object and nothing else. " +
      "Do not wrap it in markdown code fences or add any prose before or after."
    );
  }
  if (type === "json_schema") {
    const schema = (responseFormat as any).json_schema;
    const schemaText = schema ? `\n\nJSON schema:\n${JSON.stringify(schema)}` : "";
    return (
      "\n\nYou must respond with a single valid JSON object that conforms to the " +
      "provided JSON schema, and nothing else. Do not wrap it in markdown code " +
      "fences or add any prose before or after." +
      schemaText
    );
  }
  return "";
}

/** Build the Kiro payload from an OpenAI request. */
export async function buildOpenAIKiroPayload(
  requestData: ChatCompletionRequest,
  conversationId: string,
  profileArn: string,
  config: Config,
): Promise<KiroPayloadResult> {
  const [systemPrompt, unifiedMessages] = convertOpenAIMessagesToUnified(
    requestData.messages as ChatMessage[],
  );
  const unifiedTools = convertOpenAIToolsToUnified(requestData.tools as Tool[] | null);
  const modelId = getModelIdForKiro(requestData.model, HIDDEN_MODELS);
  const thinkingConfig = extractThinkingConfigFromOpenAI(requestData);

  // Best-effort structured-output steering via the system prompt.
  const rfInstruction = buildResponseFormatInstruction(requestData.response_format);
  const effectiveSystemPrompt = rfInstruction
    ? systemPrompt + rfInstruction
    : systemPrompt;

  return buildKiroPayload({
    messages: unifiedMessages,
    systemPrompt: effectiveSystemPrompt,
    modelId,
    tools: unifiedTools,
    conversationId,
    profileArn,
    thinkingConfig,
    config,
  });
}
