/**
 * Anthropic → unified converter (adapter layer). Port of
 * `converters_anthropic.py`. Builds the Kiro payload from an Anthropic
 * MessagesRequest, delegating assembly to converters/core.
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
import {
  extractTextContent,
  extractImagesFromContent,
  buildKiroPayload,
  buildToolChoiceInstruction,
  type UnifiedToolChoice,
  type KiroPayloadResult,
} from "./core";
import type { AnthropicMessagesRequest } from "../models/anthropic";

function toUnifiedImages(
  raw: Array<{ media_type: string; data: string }>,
): UnifiedImage[] {
  return raw.map((i) => ({ mediaType: i.media_type, data: i.data }));
}

/** Extract plain text from Anthropic content (string or block list). */
export function convertAnthropicContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as any).type === "text") {
        parts.push((block as any).text ?? "");
      }
    }
    return parts.join("");
  }
  return content ? String(content) : "";
}

/** Extract system prompt text from the Anthropic `system` field. */
export function extractSystemPrompt(system: unknown): string {
  if (system == null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      if (block && typeof block === "object" && (block as any).type === "text") {
        parts.push((block as any).text ?? "");
      }
    }
    return parts.join("\n");
  }
  return String(system);
}

/** Extract tool_result blocks from Anthropic user content. */
function extractToolResults(content: unknown): UnifiedToolResult[] {
  const results: UnifiedToolResult[] = [];
  if (!Array.isArray(content)) return results;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as any).type === "tool_result" && (block as any).tool_use_id) {
      let rc = (block as any).content ?? "";
      if (Array.isArray(rc)) rc = extractTextContent(rc);
      else if (typeof rc !== "string") rc = rc ? String(rc) : "";
      results.push({
        toolUseId: (block as any).tool_use_id,
        content: rc || "(empty result)",
      });
    }
  }
  return results;
}

/** Extract images nested inside tool_result content blocks. */
function extractImagesFromToolResults(content: unknown): UnifiedImage[] {
  const images: UnifiedImage[] = [];
  if (!Array.isArray(content)) return images;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as any).type === "tool_result" &&
      Array.isArray((block as any).content)
    ) {
      images.push(...toUnifiedImages(extractImagesFromContent((block as any).content)));
    }
  }
  return images;
}

/** Extract tool_use blocks from Anthropic assistant content. */
function extractToolUses(content: unknown): UnifiedToolCall[] {
  const calls: UnifiedToolCall[] = [];
  if (!Array.isArray(content)) return calls;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if ((block as any).type === "tool_use" && (block as any).id && (block as any).name) {
      const input = (block as any).input ?? {};
      calls.push({
        id: (block as any).id,
        name: (block as any).name,
        // Core's extractToolUsesFromMessage handles string-or-object arguments.
        arguments: typeof input === "string" ? input : JSON.stringify(input),
      });
    }
  }
  return calls;
}

/** Convert Anthropic messages to unified format. */
export function convertAnthropicMessages(messages: any[]): UnifiedMessage[] {
  const unified: UnifiedMessage[] = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;
    const text = convertAnthropicContentToText(content);

    let toolCalls: UnifiedToolCall[] | undefined;
    let toolResults: UnifiedToolResult[] | undefined;
    let images: UnifiedImage[] | undefined;

    if (role === "assistant") {
      const tc = extractToolUses(content);
      toolCalls = tc.length ? tc : undefined;
    } else if (role === "user") {
      const tr = extractToolResults(content);
      toolResults = tr.length ? tr : undefined;

      const topImages = toUnifiedImages(extractImagesFromContent(content));
      const trImages = extractImagesFromToolResults(content);
      const all = [...topImages, ...trImages];
      images = all.length ? all : undefined;
    }

    unified.push({ role, content: text, toolCalls, toolResults, images });
  }
  return unified;
}

/** Convert Anthropic tools to unified tools. */
export function convertAnthropicTools(
  tools: any[] | null | undefined,
): UnifiedTool[] | null {
  if (!tools || tools.length === 0) return null;
  const unified: UnifiedTool[] = tools.map((tool) => ({
    name: tool.name ?? "",
    description: tool.description ?? "",
    inputSchema: tool.input_schema ?? {},
  }));
  return unified.length ? unified : null;
}

/** Extract thinking config from an Anthropic request's `thinking` field. */
export function extractThinkingConfigFromAnthropic(
  request: AnthropicMessagesRequest,
): ThinkingConfig {
  const thinking = request.thinking;
  if (!thinking || typeof thinking !== "object") {
    return { enabled: true, budgetTokens: null };
  }
  const type = (thinking as any).type;
  if (type === "disabled") return { enabled: false, budgetTokens: null };
  if (type === "enabled") {
    const budget = (thinking as any).budget_tokens;
    return { enabled: true, budgetTokens: budget ?? null };
  }
  return { enabled: true, budgetTokens: null };
}

/**
 * Normalize Anthropic `tool_choice` into the provider-neutral form. Anthropic
 * accepts `{type:"auto"}`, `{type:"any"}` (must use some tool), `{type:"tool",
 * name}` (must use the named tool), or `{type:"none"}` (must not). Anything
 * unrecognized maps to "auto" (no steering).
 */
export function normalizeAnthropicToolChoice(
  toolChoice: unknown,
): UnifiedToolChoice | null {
  if (toolChoice == null || typeof toolChoice !== "object") return null;
  const type = (toolChoice as any).type;
  if (type === "any") return { mode: "required" };
  if (type === "none") return { mode: "none" };
  if (type === "tool") {
    const name = (toolChoice as any).name;
    if (typeof name === "string" && name) return { mode: "tool", name };
    return { mode: "required" };
  }
  return { mode: "auto" };
}

/** Build the Kiro payload from an Anthropic request. */
export async function anthropicToKiro(
  request: AnthropicMessagesRequest,
  conversationId: string,
  profileArn: string,
  config: Config,
): Promise<KiroPayloadResult> {
  const unifiedMessages = convertAnthropicMessages(request.messages as any[]);
  const unifiedTools = convertAnthropicTools(request.tools as any[] | null);
  const systemPrompt = extractSystemPrompt(request.system);
  const modelId = getModelIdForKiro(request.model, HIDDEN_MODELS);
  const thinkingConfig = extractThinkingConfigFromAnthropic(request);

  // Best-effort tool_choice steering (Kiro has no native forced-tool control).
  const tcInstruction = buildToolChoiceInstruction(
    normalizeAnthropicToolChoice(request.tool_choice),
    !!(unifiedTools && unifiedTools.length),
  );
  const effectiveSystemPrompt = systemPrompt + tcInstruction;

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
