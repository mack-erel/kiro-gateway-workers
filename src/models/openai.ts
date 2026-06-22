/**
 * Zod schemas for the OpenAI-compatible request surface.
 *
 * Ported from `kiro/models_openai.py`. Pydantic's `extra: "allow"` maps to
 * `.passthrough()` so unknown fields survive (forward compatibility). Only the
 * request schema needs validation; responses are assembled as plain objects by
 * the streaming/converter layers.
 */
import { z } from "zod";

/** Chat message. `content` may be string | array | object | null. */
export const chatMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.any()), z.any()]).nullish(),
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

    // Generation parameters (accepted; most are ignored downstream)
    temperature: z.number().nullish(),
    top_p: z.number().nullish(),
    n: z.number().int().nullish().default(1),
    max_tokens: z.number().int().nullish(),
    max_completion_tokens: z.number().int().nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    presence_penalty: z.number().nullish(),
    frequency_penalty: z.number().nullish(),

    // Reasoning (OpenAI reasoning models)
    reasoning_effort: reasoningEffortSchema.nullish(),

    // Tools (function calling)
    tools: z.array(toolSchema).nullish(),
    tool_choice: z.union([z.string(), z.record(z.any())]).nullish(),

    // Compatibility fields (accepted, ignored)
    stream_options: z.record(z.any()).nullish(),
    logit_bias: z.record(z.number()).nullish(),
    logprobs: z.boolean().nullish(),
    top_logprobs: z.number().int().nullish(),
    user: z.string().nullish(),
    seed: z.number().int().nullish(),
    parallel_tool_calls: z.boolean().nullish(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
