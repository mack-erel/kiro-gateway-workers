/**
 * Core converters: shared logic for building the Kiro payload from the unified
 * message format. Faithful port of `kiro/converters_core.py`.
 *
 * Used by both the OpenAI and Anthropic adapters. Handles text extraction,
 * image/tool conversion, thinking-tag injection, message normalization (role
 * alternation, merging), history building, and final payload assembly.
 */
import type { Config } from "../config";
import type {
  ThinkingConfig,
  UnifiedMessage,
  UnifiedTool,
} from "../types";
import { checkPayloadSize, trimPayloadToLimit, PayloadTooLargeError } from "../lib/payloadGuards";
import { logWarn } from "../lib/log";

export interface KiroPayloadResult {
  payload: Record<string, any>;
  toolDocumentation: string;
}

// ============================================================================
// Text & image extraction
// ============================================================================

/** Extract plain text from a string, content-block list, or null. */
export function extractTextContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const type = (item as any).type;
        if (type === "image" || type === "image_url" || type === "tool_reference") {
          continue;
        }
        if (type === "text") {
          parts.push((item as any).text ?? "");
        } else if ("text" in (item as any)) {
          parts.push((item as any).text ?? "");
        }
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    return parts.join("");
  }
  return String(content);
}

/** Unified image shape used internally. */
interface ExtractedImage {
  media_type: string;
  data: string;
}

/**
 * Extract images from message content. Supports OpenAI (`image_url` data URL)
 * and Anthropic (`image` + base64 source) formats. URL images are unsupported
 * (skipped with a warning), matching the Python behavior.
 */
export function extractImagesFromContent(content: unknown): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  if (!Array.isArray(content)) return images;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const itemType = (item as any).type;

    if (itemType === "image_url") {
      const imageUrlObj = (item as any).image_url ?? {};
      const url = typeof imageUrlObj === "object" ? (imageUrlObj.url ?? "") : "";
      if (url.startsWith("data:")) {
        const commaIdx = url.indexOf(",");
        if (commaIdx !== -1) {
          const header = url.slice(0, commaIdx);
          const data = url.slice(commaIdx + 1);
          const mediaPart = header.split(";")[0]; // "data:image/jpeg"
          const mediaType = mediaPart.replace("data:", "");
          if (data) images.push({ media_type: mediaType, data });
        }
      } else if (url.startsWith("http")) {
        logWarn("image.dropped", { format: "openai", source: "url", reason: "Kiro API accepts inline data: images only" });
      }
    } else if (itemType === "image") {
      const source = (item as any).source;
      if (!source || typeof source !== "object") continue;
      if (source.type === "base64") {
        const mediaType = source.media_type ?? "image/jpeg";
        const data = source.data ?? "";
        if (data) images.push({ media_type: mediaType, data });
      } else if (source.type === "url") {
        logWarn("image.dropped", { format: "anthropic", source: "url", reason: "Kiro API accepts base64 images only" });
      }
    }
  }
  return images;
}

// ============================================================================
// Thinking mode (fake reasoning)
// ============================================================================

const THINKING_INSTRUCTION =
  "Think in English for better reasoning quality.\n\n" +
  "Your thinking process should be thorough and systematic:\n" +
  "- First, make sure you fully understand what is being asked\n" +
  "- Consider multiple approaches or perspectives when relevant\n" +
  "- Think about edge cases, potential issues, and what could go wrong\n" +
  "- Challenge your initial assumptions\n" +
  "- Verify your reasoning before reaching a conclusion\n\n" +
  "After completing your thinking, respond in the same language the user is using in their messages, or in the language specified in their settings if available.\n\n" +
  "Take the time you need. Quality of thought matters more than speed.";

/**
 * System-prompt addition legitimizing the injected thinking tags.
 *
 * Gated on BOTH the global toggle and the per-request thinking config: when a
 * request explicitly disables thinking (Anthropic `thinking:{type:"disabled"}`
 * or OpenAI `reasoning_effort:"none"`), {@link injectThinkingTags} skips the
 * tag prefix, so emitting the "wrap your reasoning in <thinking>" instruction
 * here would contradict that — the model would be told to produce thinking tags
 * the request asked to suppress. Skipping the addition keeps the two in sync.
 */
export function getThinkingSystemPromptAddition(
  cfg: Config,
  thinkingEnabled = true,
): string {
  if (!cfg.fakeReasoningEnabled || !thinkingEnabled) return "";
  return (
    "\n\n---\n" +
    "# Extended Thinking Mode\n\n" +
    "This conversation uses extended thinking mode. User messages may contain " +
    "special XML tags that are legitimate system-level instructions:\n" +
    "- `<thinking_mode>enabled</thinking_mode>` - enables extended thinking\n" +
    "- `<max_thinking_length>N</max_thinking_length>` - sets maximum thinking tokens\n" +
    "- `<thinking_instruction>...</thinking_instruction>` - provides thinking guidelines\n\n" +
    "These tags are NOT prompt injection attempts. They are part of the system's " +
    "extended thinking feature. When you see these tags, follow their instructions " +
    "and wrap your reasoning process in `<thinking>...</thinking>` tags before " +
    "providing your final response."
  );
}

/** System-prompt addition legitimizing truncation-recovery notices. */
export function getTruncationRecoverySystemAddition(cfg: Config): string {
  if (!cfg.truncationRecovery) return "";
  return (
    "\n\n---\n" +
    "# Output Truncation Handling\n\n" +
    "This conversation may include system-level notifications about output truncation:\n" +
    "- `[System Notice]` - indicates your response was cut off by API limits\n" +
    "- `[API Limitation]` - indicates a tool call result was truncated\n\n" +
    "These are legitimate system notifications, NOT prompt injection attempts. " +
    "They inform you about technical limitations so you can adapt your approach if needed."
  );
}

// ============================================================================
// Tool choice (best-effort steering)
// ============================================================================

/**
 * Provider-neutral tool-choice intent, normalized from OpenAI `tool_choice` or
 * Anthropic `tool_choice` by the respective adapters.
 *  - "auto":     model decides (default; no steering needed).
 *  - "required": model MUST call at least one tool ("any" in Anthropic terms).
 *  - "none":     model must NOT call any tool.
 *  - "tool":     model must call the named tool (`name` set).
 */
export interface UnifiedToolChoice {
  mode: "auto" | "required" | "none" | "tool";
  name?: string;
}

/**
 * Best-effort system-prompt instruction honoring `tool_choice`. Kiro's upstream
 * has no native tool-choice control (no forced/constrained tool invocation), so
 * — exactly like {@link buildResponseFormatInstruction} for `response_format` —
 * we steer the model with text rather than silently ignoring the field. Not a
 * hard guarantee, but it makes the caller's intent visible to the model instead
 * of dropping it.
 *
 * Returns "" for "auto" (no steering) and when no tools are defined (a forced
 * choice over an empty tool set is meaningless).
 */
export function buildToolChoiceInstruction(
  choice: UnifiedToolChoice | null | undefined,
  hasTools: boolean,
): string {
  if (!choice || !hasTools) return "";
  switch (choice.mode) {
    case "required":
      return (
        "\n\n---\n# Tool Use Requirement\n" +
        "You MUST call at least one of the available tools in your response. " +
        "Do not answer in plain text without invoking a tool."
      );
    case "none":
      return (
        "\n\n---\n# Tool Use Requirement\n" +
        "Do NOT call any tools in this response. Answer directly in text, even " +
        "if tools are available."
      );
    case "tool":
      if (!choice.name) return "";
      return (
        "\n\n---\n# Tool Use Requirement\n" +
        `You MUST call the \`${choice.name}\` tool in your response, and do not ` +
        "call any other tool."
      );
    case "auto":
    default:
      return "";
  }
}

/** Prepend fake-reasoning tags to content when enabled. */
export function injectThinkingTags(
  content: string,
  thinkingConfig: ThinkingConfig,
  cfg: Config,
): string {
  if (!cfg.fakeReasoningEnabled) return content;
  if (!thinkingConfig.enabled) return content;

  let effectiveBudget =
    thinkingConfig.budgetTokens !== null
      ? thinkingConfig.budgetTokens
      : cfg.fakeReasoningMaxTokens;

  if (cfg.fakeReasoningBudgetCap > 0 && effectiveBudget > cfg.fakeReasoningBudgetCap) {
    effectiveBudget = cfg.fakeReasoningBudgetCap;
  }

  const prefix =
    `<thinking_mode>enabled</thinking_mode>\n` +
    `<max_thinking_length>${effectiveBudget}</max_thinking_length>\n` +
    `<thinking_instruction>${THINKING_INSTRUCTION}</thinking_instruction>\n\n`;

  return prefix + content;
}

// ============================================================================
// JSON Schema sanitization
// ============================================================================

/**
 * Remove fields Kiro rejects (empty `required: []`, `additionalProperties`).
 * Recursively processes nested schemas. Mirrors `sanitize_json_schema`.
 */
export function sanitizeJsonSchema(
  schema: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!schema) return {};
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value) && value.length === 0) {
      continue;
    }
    if (key === "additionalProperties") continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, any> = {};
      for (const [propName, propValue] of Object.entries(value)) {
        props[propName] =
          propValue && typeof propValue === "object" && !Array.isArray(propValue)
            ? sanitizeJsonSchema(propValue as Record<string, any>)
            : propValue;
      }
      result[key] = props;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeJsonSchema(value as Record<string, any>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? sanitizeJsonSchema(item as Record<string, any>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ============================================================================
// Tool processing
// ============================================================================

export const TOOL_NAME_MAX_LENGTH = 64;

/**
 * Move tool descriptions longer than the limit into the system prompt, leaving
 * a reference in the tool. Returns processed tools + doc text. Mirrors
 * `process_tools_with_long_descriptions`.
 */
export function processToolsWithLongDescriptions(
  tools: UnifiedTool[] | null,
  maxLength: number,
): [UnifiedTool[] | null, string] {
  if (!tools || tools.length === 0) return [null, ""];
  if (maxLength <= 0) return [tools, ""];

  const docParts: string[] = [];
  const processed: UnifiedTool[] = [];

  for (const tool of tools) {
    const description = tool.description || "";
    if (description.length <= maxLength) {
      processed.push(tool);
    } else {
      docParts.push(`## Tool: ${tool.name}\n\n${description}`);
      processed.push({
        name: tool.name,
        description: `[Full documentation in system prompt under '## Tool: ${tool.name}']`,
        inputSchema: tool.inputSchema,
      });
    }
  }

  let toolDocumentation = "";
  if (docParts.length > 0) {
    toolDocumentation =
      "\n\n---\n# Tool Documentation\n" +
      "The following tools have detailed documentation that couldn't fit in the tool definition.\n\n" +
      docParts.join("\n\n---\n\n");
  }

  return [processed.length > 0 ? processed : null, toolDocumentation];
}

/** Hex SHA-1 of a string via Web Crypto (async). */
async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministically shorten a tool name to fit Kiro's 64-char limit. Names
 * within the limit are unchanged; longer names map to a 64-char prefix+SHA-1
 * alias. Async (Web Crypto). Mirrors `shorten_tool_name`.
 */
export async function shortenToolName(name: string): Promise<string> {
  if (name.length <= TOOL_NAME_MAX_LENGTH) return name;
  const digest = (await sha1Hex(name)).slice(0, 12);
  return `${name.slice(0, 51)}_${digest}`; // 51 + 1 + 12 = 64
}

/** Build a {alias: original} map for tool names that get shortened. */
export async function buildToolNameReverseMap(
  names: Iterable<string>,
): Promise<Record<string, string>> {
  const reverse: Record<string, string> = {};
  for (const name of names) {
    const alias = await shortenToolName(name);
    if (alias !== name) reverse[alias] = name;
  }
  return reverse;
}

/** Convert unified tools to Kiro toolSpecification format. */
export function convertToolsToKiroFormat(
  tools: UnifiedTool[] | null,
): Record<string, any>[] {
  if (!tools || tools.length === 0) return [];

  const kiroTools: Record<string, any>[] = [];
  for (const tool of tools) {
    const sanitized = sanitizeJsonSchema(tool.inputSchema);
    // Kiro/Bedrock requires the root input schema to be an object schema.
    if (sanitized["type"] !== "object") sanitized["type"] = "object";
    if (!("properties" in sanitized)) sanitized["properties"] = {};

    let description = tool.description;
    if (!description || !description.trim()) {
      description = `Tool: ${tool.name}`;
    }

    kiroTools.push({
      toolSpecification: {
        name: tool.name,
        description,
        inputSchema: { json: sanitized },
      },
    });
  }
  return kiroTools;
}

// ============================================================================
// Image / tool-result / tool-use conversion
// ============================================================================

/** Convert unified images to Kiro format (`{format, source:{bytes}}`). */
export function convertImagesToKiroFormat(
  images: ExtractedImage[] | null | undefined,
): Record<string, any>[] {
  if (!images || images.length === 0) return [];

  const kiroImages: Record<string, any>[] = [];
  for (const img of images) {
    let mediaType = img.media_type ?? "image/jpeg";
    let data = img.data ?? "";
    if (!data) continue;

    if (data.startsWith("data:")) {
      const commaIdx = data.indexOf(",");
      if (commaIdx !== -1) {
        const header = data.slice(0, commaIdx);
        const actualData = data.slice(commaIdx + 1);
        const extracted = header.split(";")[0].replace("data:", "");
        if (extracted) mediaType = extracted;
        data = actualData;
      }
    }

    // Kiro/Bedrock accepts a fixed set of raster formats. Deriving the format
    // from the media type naively yields e.g. "svg+xml" for "image/svg+xml",
    // which Kiro rejects. Map to an accepted format, defaulting unknown types to
    // "png" (the safest common denominator) and logging the coercion.
    const ACCEPTED_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);
    let formatStr = mediaType.includes("/")
      ? mediaType.split("/").pop()!.toLowerCase()
      : mediaType.toLowerCase();
    if (formatStr === "jpg") formatStr = "jpeg";
    if (!ACCEPTED_FORMATS.has(formatStr)) {
      logWarn("image.format.unsupported", { mediaType, derived: formatStr, coercedTo: "png" });
      formatStr = "png";
    }
    kiroImages.push({ format: formatStr, source: { bytes: data } });
  }
  return kiroImages;
}

/** Convert unified tool results to Kiro format. */
export function convertToolResultsToKiroFormat(
  toolResults: Array<Record<string, any>>,
): Record<string, any>[] {
  return toolResults.map((tr) => {
    const content = tr["content"] ?? "";
    let text = typeof content === "string" ? content : extractTextContent(content);
    if (!text) text = "(empty result)";
    return {
      content: [{ text }],
      status: "success",
      toolUseId: tr["tool_use_id"] ?? tr["toolUseId"] ?? "",
    };
  });
}

/** Extract `tool_result` blocks already present in content (Kiro form). */
export function extractToolResultsFromContent(
  content: unknown,
): Record<string, any>[] {
  const results: Record<string, any>[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (item as any).type === "tool_result") {
        results.push({
          content: [
            { text: extractTextContent((item as any).content ?? "") || "(empty result)" },
          ],
          status: "success",
          toolUseId: (item as any).tool_use_id ?? "",
        });
      }
    }
  }
  return results;
}

/** Extract tool uses from an assistant message (OpenAI tool_calls + content blocks). */
export function extractToolUsesFromMessage(
  content: unknown,
  toolCalls?: Array<Record<string, any>> | null,
): Record<string, any>[] {
  const toolUses: Record<string, any>[] = [];

  if (toolCalls) {
    for (const tc of toolCalls) {
      if (tc && typeof tc === "object") {
        const func = tc["function"] ?? {};
        const args = func["arguments"] ?? "{}";
        let input: unknown;
        if (typeof args === "string") {
          // LLM-generated tool arguments are frequently invalid JSON (trailing
          // commas, unescaped chars, mid-stream truncation). A single bad
          // arguments string in conversation HISTORY must not throw and fail the
          // whole request — fall back to {} (matching the streaming parsers'
          // resilience). The raw string is preserved under _raw for debugging.
          if (!args) {
            input = {};
          } else {
            try {
              input = JSON.parse(args);
            } catch {
              input = { _raw: args };
            }
          }
        } else {
          input = args ? args : {};
        }
        toolUses.push({
          name: func["name"] ?? "",
          input,
          toolUseId: tc["id"] ?? "",
        });
      }
    }
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (item as any).type === "tool_use") {
        toolUses.push({
          name: (item as any).name ?? "",
          input: (item as any).input ?? {},
          toolUseId: (item as any).id ?? "",
        });
      }
    }
  }

  return toolUses;
}

// ============================================================================
// Tool content → text (when no tools are defined)
// ============================================================================

function toolCallsToText(toolCalls: Array<Record<string, any>>): string {
  if (!toolCalls || toolCalls.length === 0) return "";
  const parts: string[] = [];
  for (const tc of toolCalls) {
    const func = tc["function"] ?? {};
    const name = func["name"] ?? "unknown";
    const args = func["arguments"] ?? "{}";
    const id = tc["id"] ?? "";
    parts.push(id ? `[Tool: ${name} (${id})]\n${args}` : `[Tool: ${name}]\n${args}`);
  }
  return parts.join("\n\n");
}

function toolResultsToText(toolResults: Array<Record<string, any>>): string {
  if (!toolResults || toolResults.length === 0) return "";
  const parts: string[] = [];
  for (const tr of toolResults) {
    const content = tr["content"] ?? "";
    const id = tr["tool_use_id"] ?? tr["toolUseId"] ?? "";
    let text = typeof content === "string" ? content : extractTextContent(content);
    if (!text) text = "(empty result)";
    parts.push(id ? `[Tool Result (${id})]\n${text}` : `[Tool Result]\n${text}`);
  }
  return parts.join("\n\n");
}

// ============================================================================
// Message normalization
// ============================================================================

/** Strip all tool content to text (used when no tools are defined). */
export function stripAllToolContent(
  messages: UnifiedMessage[],
): [UnifiedMessage[], boolean] {
  if (messages.length === 0) return [[], false];

  const result: UnifiedMessage[] = [];
  let stripped = 0;

  for (const msg of messages) {
    const hasToolCalls = !!(msg.toolCalls && msg.toolCalls.length);
    const hasToolResults = !!(msg.toolResults && msg.toolResults.length);

    if (hasToolCalls || hasToolResults) {
      if (hasToolCalls) stripped += msg.toolCalls!.length;
      if (hasToolResults) stripped += msg.toolResults!.length;

      const parts: string[] = [];
      const existing = extractTextContent(msg.content);
      if (existing) parts.push(existing);
      if (hasToolCalls) {
        const t = toolCallsToText(msg.toolCalls as any);
        if (t) parts.push(t);
      }
      if (hasToolResults) {
        const t = toolResultsToText(msg.toolResults as any);
        if (t) parts.push(t);
      }
      const content = parts.length ? parts.join("\n\n") : "(empty placeholder)";

      result.push({
        role: msg.role,
        content,
        toolCalls: undefined,
        toolResults: undefined,
        images: msg.images,
      });
    } else {
      result.push(msg);
    }
  }

  return [result, stripped > 0];
}

/** Convert orphaned tool_results (no preceding assistant tool_calls) to text. */
export function ensureAssistantBeforeToolResults(
  messages: UnifiedMessage[],
): [UnifiedMessage[], boolean] {
  if (messages.length === 0) return [[], false];

  const result: UnifiedMessage[] = [];
  let convertedAny = false;

  for (const msg of messages) {
    if (msg.toolResults && msg.toolResults.length) {
      const prev = result[result.length - 1];
      const hasPrecedingAssistant =
        prev && prev.role === "assistant" && !!(prev.toolCalls && prev.toolCalls.length);

      if (!hasPrecedingAssistant) {
        const trText = toolResultsToText(msg.toolResults as any);
        const original = extractTextContent(msg.content) || "";
        let newContent: string;
        if (original && trText) newContent = `${original}\n\n${trText}`;
        else if (trText) newContent = trText;
        else newContent = original;

        result.push({
          role: msg.role,
          content: newContent,
          toolCalls: msg.toolCalls,
          toolResults: undefined,
          images: msg.images,
        });
        convertedAny = true;
        continue;
      }
    }
    result.push(msg);
  }

  return [result, convertedAny];
}

/** Merge adjacent messages with the same role (Kiro requires alternation). */
export function mergeAdjacentMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length === 0) return [];

  const merged: UnifiedMessage[] = [];
  for (const msg of messages) {
    if (merged.length === 0) {
      merged.push({ ...msg });
      continue;
    }
    const last = merged[merged.length - 1];
    if (msg.role === last.role) {
      const lastText = extractTextContent(last.content);
      const currentText = extractTextContent(msg.content);
      last.content = `${lastText}\n${currentText}`;

      if (msg.role === "assistant" && msg.toolCalls) {
        last.toolCalls = [...(last.toolCalls ?? []), ...msg.toolCalls];
      }
      if (msg.role === "user" && msg.toolResults) {
        last.toolResults = [...(last.toolResults ?? []), ...msg.toolResults];
      }
      if (msg.images) {
        last.images = [...(last.images ?? []), ...msg.images];
      }
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

/** Prepend a synthetic user message if the conversation doesn't start with user. */
export function ensureFirstMessageIsUser(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length === 0) return messages;
  if (messages[0].role !== "user") {
    return [{ role: "user", content: "(empty placeholder)" }, ...messages];
  }
  return messages;
}

/** Normalize unknown roles (system/developer/…) to 'user'. */
export function normalizeMessageRoles(messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.map((msg) =>
    msg.role !== "user" && msg.role !== "assistant"
      ? { ...msg, role: "user" as const }
      : msg,
  );
}

/** Insert synthetic assistant messages between consecutive user messages. */
export function ensureAlternatingRoles(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (messages.length < 2) return messages;

  const result: UnifiedMessage[] = [messages[0]];
  for (const msg of messages.slice(1)) {
    const prevRole = result[result.length - 1].role;
    if (msg.role === "user" && prevRole === "user") {
      result.push({ role: "assistant", content: "(empty placeholder)" });
    }
    result.push(msg);
  }
  return result;
}

// ============================================================================
// History building
// ============================================================================

/** Build the Kiro `history` array from unified messages. */
export function buildKiroHistory(
  messages: UnifiedMessage[],
  modelId: string,
): Record<string, any>[] {
  const history: Record<string, any>[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = extractTextContent(msg.content) || "(empty placeholder)";
      const userInput: Record<string, any> = {
        content,
        modelId,
        origin: "AI_EDITOR",
      };

      const images =
        msg.images && msg.images.length
          ? msg.images.map((i) => ({ media_type: i.mediaType, data: i.data }))
          : extractImagesFromContent(msg.content);
      if (images.length) {
        const kiroImages = convertImagesToKiroFormat(images);
        if (kiroImages.length) userInput["images"] = kiroImages;
      }

      const ctx: Record<string, any> = {};
      if (msg.toolResults && msg.toolResults.length) {
        const kiro = convertToolResultsToKiroFormat(
          msg.toolResults.map((tr) => ({
            content: tr.content,
            tool_use_id: tr.toolUseId,
          })),
        );
        if (kiro.length) ctx["toolResults"] = kiro;
      } else {
        const fromContent = extractToolResultsFromContent(msg.content);
        if (fromContent.length) ctx["toolResults"] = fromContent;
      }
      if (Object.keys(ctx).length) userInput["userInputMessageContext"] = ctx;

      history.push({ userInputMessage: userInput });
    } else if (msg.role === "assistant") {
      const content = extractTextContent(msg.content) || "(empty placeholder)";
      const assistantResponse: Record<string, any> = { content };

      const toolUses = extractToolUsesFromMessage(
        msg.content,
        msg.toolCalls?.map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      );
      if (toolUses.length) assistantResponse["toolUses"] = toolUses;

      history.push({ assistantResponseMessage: assistantResponse });
    }
  }

  return history;
}

// ============================================================================
// Main payload builder
// ============================================================================

/**
 * Assemble the complete Kiro API payload from unified data. Faithful port of
 * `build_kiro_payload`. Throws if there are no messages to send.
 */
export async function buildKiroPayload(args: {
  messages: UnifiedMessage[];
  systemPrompt: string;
  modelId: string;
  tools: UnifiedTool[] | null;
  conversationId: string;
  profileArn: string;
  thinkingConfig: ThinkingConfig;
  config: Config;
}): Promise<KiroPayloadResult> {
  const { messages, systemPrompt, modelId, tools, conversationId, profileArn, thinkingConfig, config } = args;

  const [processedTools, toolDocumentation] = processToolsWithLongDescriptions(
    tools,
    config.toolDescriptionMaxLength,
  );

  // Alias tool names over Kiro's 64-char limit (deterministic, async hashing).
  // Guard against the (astronomically unlikely but unhandled) case where an
  // alias collides with another tool's final name — without a guard the forward
  // map would silently overwrite and two distinct tools would merge into one.
  // On collision, append a short disambiguating counter while staying ≤64 chars.
  const toolNameForwardMap: Record<string, string> = {};
  if (processedTools) {
    const usedNames = new Set<string>();
    for (const tool of processedTools) {
      let alias = await shortenToolName(tool.name);
      if (usedNames.has(alias)) {
        let counter = 1;
        let candidate: string;
        do {
          const suffix = `_${counter}`;
          candidate = alias.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length) + suffix;
          counter += 1;
        } while (usedNames.has(candidate) && counter < 1000);
        logWarn("toolname.alias.collision", {
          original: tool.name,
          collidedAlias: alias,
          resolvedAlias: candidate,
        });
        alias = candidate;
      }
      usedNames.add(alias);
      if (alias !== tool.name) {
        toolNameForwardMap[tool.name] = alias;
        tool.name = alias;
      }
    }
  }

  // Build the full system prompt (tool docs + thinking + truncation additions).
  let fullSystemPrompt = systemPrompt;
  if (toolDocumentation) {
    fullSystemPrompt = fullSystemPrompt
      ? fullSystemPrompt + toolDocumentation
      : toolDocumentation.trim();
  }
  const thinkingAddition = getThinkingSystemPromptAddition(
    config,
    thinkingConfig.enabled,
  );
  if (thinkingAddition) {
    fullSystemPrompt = fullSystemPrompt
      ? fullSystemPrompt + thinkingAddition
      : thinkingAddition.trim();
  }
  const truncationAddition = getTruncationRecoverySystemAddition(config);
  if (truncationAddition) {
    fullSystemPrompt = fullSystemPrompt
      ? fullSystemPrompt + truncationAddition
      : truncationAddition.trim();
  }

  // No tools defined → strip tool content; else fix orphaned tool_results.
  let withAssistants: UnifiedMessage[];
  if (!tools) {
    [withAssistants] = stripAllToolContent(messages);
  } else {
    [withAssistants] = ensureAssistantBeforeToolResults(messages);
  }

  let mergedMessages = mergeAdjacentMessages(withAssistants);
  mergedMessages = ensureFirstMessageIsUser(mergedMessages);
  mergedMessages = normalizeMessageRoles(mergedMessages);
  mergedMessages = ensureAlternatingRoles(mergedMessages);

  if (mergedMessages.length === 0) {
    throw new Error("No messages to send");
  }

  // History = all but the last message.
  const historyMessages = mergedMessages.length > 1 ? mergedMessages.slice(0, -1) : [];

  // Prepend system prompt to the first user message in history.
  if (fullSystemPrompt && historyMessages.length) {
    const first = historyMessages[0];
    if (first.role === "user") {
      const original = extractTextContent(first.content);
      first.content = `${fullSystemPrompt}\n\n${original}`;
    }
  }

  const history = buildKiroHistory(historyMessages, modelId);

  // Apply tool-name aliases to toolUses referenced in history.
  if (Object.keys(toolNameForwardMap).length) {
    for (const entry of history) {
      const assistant = entry["assistantResponseMessage"];
      if (!assistant) continue;
      for (const toolUse of assistant["toolUses"] ?? []) {
        const aliased = toolNameForwardMap[toolUse["name"]];
        if (aliased) toolUse["name"] = aliased;
      }
    }
  }

  const currentMessage = mergedMessages[mergedMessages.length - 1];
  let currentContent = extractTextContent(currentMessage.content);

  // System prompt with empty history → prepend to current message.
  if (fullSystemPrompt && history.length === 0) {
    currentContent = `${fullSystemPrompt}\n\n${currentContent}`;
  }

  // If the last message is from assistant, push it to history + user placeholder.
  if (currentMessage.role === "assistant") {
    history.push({ assistantResponseMessage: { content: currentContent } });
    currentContent = "(empty placeholder)";
  }
  if (!currentContent) currentContent = "(empty placeholder)";

  // Current-message images.
  const images =
    currentMessage.images && currentMessage.images.length
      ? currentMessage.images.map((i) => ({ media_type: i.mediaType, data: i.data }))
      : extractImagesFromContent(currentMessage.content);
  const kiroImages = images.length ? convertImagesToKiroFormat(images) : null;

  // userInputMessageContext: tools + toolResults (not images).
  const ctx: Record<string, any> = {};
  const kiroTools = convertToolsToKiroFormat(processedTools);
  if (kiroTools.length) ctx["tools"] = kiroTools;

  if (currentMessage.toolResults && currentMessage.toolResults.length) {
    const kiro = convertToolResultsToKiroFormat(
      currentMessage.toolResults.map((tr) => ({
        content: tr.content,
        tool_use_id: tr.toolUseId,
      })),
    );
    if (kiro.length) ctx["toolResults"] = kiro;
  } else {
    const fromContent = extractToolResultsFromContent(currentMessage.content);
    if (fromContent.length) ctx["toolResults"] = fromContent;
  }

  // Inject thinking tags only for a current user message.
  if (currentMessage.role === "user") {
    currentContent = injectThinkingTags(currentContent, thinkingConfig, config);
  }

  const userInputMessage: Record<string, any> = {
    content: currentContent,
    modelId,
    origin: "AI_EDITOR",
  };
  if (kiroImages && kiroImages.length) userInputMessage["images"] = kiroImages;
  if (Object.keys(ctx).length) userInputMessage["userInputMessageContext"] = ctx;

  const payload: Record<string, any> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage },
    },
  };
  if (history.length) payload["conversationState"]["history"] = history;
  if (profileArn) payload["profileArn"] = profileArn;

  // Payload-size guard. With auto-trim on, trim oldest history to fit; with it
  // off, reject loudly rather than forwarding an oversize payload that Kiro
  // bounces back as a misleading "Improperly formed request." 400.
  if (checkPayloadSize(payload) > config.maxPayloadBytes) {
    if (config.autoTrimPayload) {
      const stats = trimPayloadToLimit(payload, config.maxPayloadBytes, fullSystemPrompt);
      // Auto-trim silently discards oldest history to fit Kiro's ~615 KB cap —
      // log it so the context loss is visible (the model may otherwise seem to
      // "forget" earlier turns with no trace).
      if (stats.trimmed) {
        logWarn("payload.autotrimmed", {
          originalBytes: stats.originalBytes,
          finalBytes: stats.finalBytes,
          originalEntries: stats.originalEntries,
          finalEntries: stats.finalEntries,
          droppedEntries: stats.originalEntries - stats.finalEntries,
        });
      }
      // Dropping history cannot reach the current message or the two entries it
      // always keeps, so oversized bodies there get shortened middle-out.
      if (stats.truncatedSlots > 0) {
        logWarn("payload.truncated", {
          originalBytes: stats.originalBytes,
          finalBytes: stats.finalBytes,
          truncatedSlots: stats.truncatedSlots,
          truncatedBytes: stats.truncatedBytes,
        });
      }
      // Still over: the untouchable remainder (system prompt plus each body's
      // retained head and tail) exceeds the limit on its own.
      const after = checkPayloadSize(payload);
      if (after > config.maxPayloadBytes) {
        throw new PayloadTooLargeError(after, config.maxPayloadBytes);
      }
    } else {
      throw new PayloadTooLargeError(checkPayloadSize(payload), config.maxPayloadBytes);
    }
  }

  return { payload, toolDocumentation };
}
