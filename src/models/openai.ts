/**
 * Zod schemas for the OpenAI-compatible request surface.
 *
 * Ported from `kiro/models_openai.py`. Pydantic's `extra: "allow"` maps to
 * `.passthrough()` so unknown fields survive (forward compatibility). Only the
 * request schema needs validation; responses are assembled as plain objects by
 * the streaming/converter layers.
 */
import { z } from "zod";

/**
 * Chat message role. OpenAI's documented roles plus `developer` (the newer
 * system-equivalent) and legacy `function`. Kept as an enum so a message with
 * no/invalid role is rejected at validation rather than silently failing later
 * in payload build.
 */
export const chatRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
  "function",
  "developer",
]);

/**
 * Chat message. `content` is string | array-of-parts | null (null is valid for
 * assistant messages carrying only tool_calls). The previous schema included a
 * bare `z.any()` branch which collapsed the union to "accept anything" — a
 * message like `{}` passed validation and only failed downstream. Dropping it
 * makes content genuinely validated while `.passthrough()` still preserves
 * unknown top-level fields for forward compatibility.
 */
export const chatMessageSchema = z
  .object({
    role: chatRoleSchema,
    content: z.union([z.string(), z.array(z.any())]).nullish(),
    name: z.string().nullish(),
    tool_calls: z.array(z.any()).nullish(),
    tool_call_id: z.string().nullish(),
  })
  .passthrough();

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Tool function descriptor (standard OpenAI format). */
const toolFunctionSchema = z
  .object({
    name: z.string(),
    description: z.string().nullish(),
    parameters: z.record(z.any()).nullish(),
  })
  .passthrough();

/**
 * Tool supporting both the standard OpenAI shape ({type, function}) and the
 * flat Cursor-style shape ({name, description, input_schema}).
 */
export const toolSchema = z
  .object({
    type: z.string().default("function"),
    function: toolFunctionSchema.nullish(),
    // Flat format (Cursor-style)
    name: z.string().nullish(),
    description: z.string().nullish(),
    input_schema: z.record(z.any()).nullish(),
  })
  .passthrough();

export type Tool = z.infer<typeof toolSchema>;

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** OpenAI Chat Completions request. */
export const chatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().default(false),

    // Generation parameters (accepted; most are ignored downstream). Bounds
    // match OpenAI's documented ranges so out-of-range values are rejected at
    // validation (a real OpenAI server 400s on these) rather than passing
    // silently. Kept .nullish() so omitting them is fine.
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    n: z.number().int().min(1).nullish().default(1),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    presence_penalty: z.number().min(-2).max(2).nullish(),
    frequency_penalty: z.number().min(-2).max(2).nullish(),

    // Reasoning (OpenAI reasoning models)
    reasoning_effort: reasoningEffortSchema.nullish(),

    // Tools (function calling)
    tools: z.array(toolSchema).nullish(),
    tool_choice: z.union([z.string(), z.record(z.any())]).nullish(),

    // Structured output. Kiro has no constrained decoding, so JSON modes are
    // honored best-effort via a system-prompt instruction (see converter).
    response_format: z
      .object({
        type: z.enum(["text", "json_object", "json_schema"]),
        json_schema: z.record(z.any()).nullish(),
      })
      .passthrough()
      .nullish(),

    // Compatibility fields (accepted, ignored)
    stream_options: z.record(z.any()).nullish(),
    logit_bias: z.record(z.number()).nullish(),
    logprobs: z.boolean().nullish(),
    top_logprobs: z.number().int().min(0).max(20).nullish(),
    user: z.string().nullish(),
    seed: z.number().int().nullish(),
    parallel_tool_calls: z.boolean().nullish(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
