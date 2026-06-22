/**
 * Zod schemas for the Anthropic Messages API request surface.
 *
 * Ported from `kiro/models_anthropic.py`. Pydantic `model_validator(before)`
 * hooks become `z.preprocess`; `extra: "allow"` becomes `.passthrough()`.
 * Response/streaming event models are assembled as plain objects elsewhere, so
 * only request validation lives here.
 */
import { z } from "zod";

// ============================================================================
// Content blocks
// ============================================================================

/** Content block "type" values understood by the gateway. */
export const KNOWN_CONTENT_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "image",
  "tool_use",
  "tool_result",
  "tool_reference",
]);

const textContentBlock = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();

const thinkingContentBlock = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().default(""),
  })
  .passthrough();

const base64ImageSource = z
  .object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  })
  .passthrough();

const urlImageSource = z
  .object({ type: z.literal("url"), url: z.string() })
  .passthrough();

const imageContentBlock = z
  .object({
    type: z.literal("image"),
    source: z.union([base64ImageSource, urlImageSource]),
  })
  .passthrough();

const toolUseContentBlock = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.any()),
  })
  .passthrough();

const toolReferenceContentBlock = z
  .object({ type: z.literal("tool_reference"), tool_name: z.string() })
  .passthrough();

const toolResultContentBlock = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z
      .union([z.string(), z.array(z.any())])
      .nullish(),
    is_error: z.boolean().nullish(),
  })
  .passthrough();

/** Any recognized content block. Unknown types are dropped before parsing. */
const contentBlock = z.union([
  textContentBlock,
  thinkingContentBlock,
  imageContentBlock,
  toolUseContentBlock,
  toolResultContentBlock,
  toolReferenceContentBlock,
]);

// ============================================================================
// Message (with unknown-block drop)
// ============================================================================

/**
 * Drop content blocks whose `type` the gateway doesn't understand, so a request
 * carrying server-side blocks (server_tool_use, advisor_tool_result, …) still
 * validates instead of failing with 422. Mirrors `_drop_unknown_content_blocks`.
 */
function dropUnknownContentBlocks(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const obj = data as Record<string, unknown>;
  const content = obj["content"];
  if (!Array.isArray(content)) return data;

  const kept = content.filter(
    (block) =>
      !(
        typeof block === "object" &&
        block !== null &&
        !KNOWN_CONTENT_BLOCK_TYPES.has((block as Record<string, unknown>)["type"] as string)
      ),
  );
  if (kept.length !== content.length) {
    return { ...obj, content: kept };
  }
  return data;
}

export const anthropicMessageSchema = z.preprocess(
  dropUnknownContentBlocks,
  z
    .object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(contentBlock)]),
    })
    .passthrough(),
);

// ============================================================================
// Tools
// ============================================================================

/**
 * Tool definition. Server-side tools carry a `type` and need no input_schema;
 * user-defined tools (no `type`) require input_schema. Mirrors
 * `validate_tool_consistency`.
 */
export const anthropicToolSchema = z
  .object({
    type: z.string().nullish(),
    name: z.string(),
    description: z.string().nullish(),
    input_schema: z.record(z.any()).nullish(),
    max_uses: z.number().int().nullish(),
    allowed_domains: z.array(z.string()).nullish(),
    blocked_domains: z.array(z.string()).nullish(),
    user_location: z.record(z.any()).nullish(),
  })
  .passthrough()
  .superRefine((tool, ctx) => {
    const isServerSide = tool.type !== null && tool.type !== undefined;
    if (!isServerSide && (tool.input_schema === null || tool.input_schema === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "input_schema is required for user-defined tools (those without a 'type' field)",
        path: ["input_schema"],
      });
    }
  });

const toolChoiceSchema = z.union([
  z.object({ type: z.literal("auto") }).passthrough(),
  z.object({ type: z.literal("any") }).passthrough(),
  z.object({ type: z.literal("tool"), name: z.string() }).passthrough(),
  z.record(z.any()),
]);

// ============================================================================
// System prompt
// ============================================================================

const systemContentBlock = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    cache_control: z.record(z.any()).nullish(),
  })
  .passthrough();

/** System prompt: a string or a list of content blocks (for prompt caching). */
export const systemPromptSchema = z.union([
  z.string(),
  z.array(systemContentBlock),
  z.array(z.record(z.any())),
]);

// ============================================================================
// hoist_system_messages
// ============================================================================

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "text"
      ) {
        parts.push(String((block as Record<string, unknown>)["text"] ?? ""));
      } else if (typeof block === "string") {
        parts.push(block);
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  return "";
}

/**
 * Pull any role=="system" entries out of `messages` and merge their text into
 * the top-level `system` field. Lenient shim for clients (e.g. Claude Code)
 * that place system turns in the array. Mirrors `hoist_system_messages`.
 */
function hoistSystemMessages(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const obj = data as Record<string, unknown>;
  const messages = obj["messages"];
  if (!Array.isArray(messages)) return data;

  const hoisted: string[] = [];
  const kept: unknown[] = [];
  for (const msg of messages) {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as Record<string, unknown>)["role"] === "system"
    ) {
      const text = contentToText((msg as Record<string, unknown>)["content"]);
      if (text) hoisted.push(text);
    } else {
      kept.push(msg);
    }
  }

  // Nothing to hoist, or hoisting would empty the array (fails min(1)).
  if (hoisted.length === 0 || kept.length === 0) return data;

  const extraSystem = hoisted.join("\n\n");
  const existing = obj["system"];
  let system: unknown;
  if (existing === null || existing === undefined) {
    system = extraSystem;
  } else if (typeof existing === "string") {
    system = existing ? `${existing}\n\n${extraSystem}` : extraSystem;
  } else if (Array.isArray(existing)) {
    system = [...existing, { type: "text", text: extraSystem }];
  } else {
    system = extraSystem;
  }

  return { ...obj, system, messages: kept };
}

// ============================================================================
// Requests
// ============================================================================

export const anthropicMessagesRequestSchema = z.preprocess(
  hoistSystemMessages,
  z
    .object({
      model: z.string(),
      messages: z.array(anthropicMessageSchema).min(1),
      max_tokens: z.number().int(),
      system: systemPromptSchema.nullish(),
      stream: z.boolean().default(false),
      thinking: z.record(z.any()).nullish(),
      tools: z.array(anthropicToolSchema).nullish(),
      tool_choice: toolChoiceSchema.nullish(),
      temperature: z.number().min(0).max(1).nullish(),
      top_p: z.number().min(0).max(1).nullish(),
      top_k: z.number().int().min(0).nullish(),
      stop_sequences: z.array(z.string()).nullish(),
      metadata: z.record(z.any()).nullish(),
    })
    .passthrough(),
);

export type AnthropicMessagesRequest = z.infer<
  typeof anthropicMessagesRequestSchema
>;

export const anthropicCountTokensRequestSchema = z.preprocess(
  hoistSystemMessages,
  z
    .object({
      model: z.string(),
      messages: z.array(anthropicMessageSchema).min(1),
      system: systemPromptSchema.nullish(),
      tools: z.array(anthropicToolSchema).nullish(),
    })
    .passthrough(),
);

export type AnthropicCountTokensRequest = z.infer<
  typeof anthropicCountTokensRequestSchema
>;

// Exported for unit tests of the preprocessing shims.
export const _internal = { hoistSystemMessages, dropUnknownContentBlocks };
