/**
 * Token counting via js-tiktoken (cl100k_base) with a Claude correction factor.
 * Faithful port of `kiro/tokenizer.py`.
 *
 * The exact Claude tokenizer is not public; cl100k_base + a 1.15 factor
 * approximates it (Claude tokenizes ~15% more than GPT-4). js-tiktoken/lite is
 * pure-JS and synchronous, so the module initializes the encoder once at load.
 */
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

export const CLAUDE_CORRECTION_FACTOR = 1.15;

const encoding = new Tiktoken(cl100k_base);

/** Count tokens in a string, optionally applying the Claude correction. */
export function countTokens(text: string, applyClaudeCorrection = true): number {
  if (!text) return 0;
  const base = encoding.encode(text).length;
  return applyClaudeCorrection ? Math.floor(base * CLAUDE_CORRECTION_FACTOR) : base;
}

type AnyRecord = Record<string, any>;

/**
 * Count tokens across a list of chat messages, mirroring the per-block logic in
 * `count_message_tokens` (text, image=100, tool_use, tool_result, tool_calls).
 * Individual blocks are counted without correction; the factor applies once to
 * the total (avoids double-correction).
 */
export function countMessageTokens(
  messages: AnyRecord[],
  applyClaudeCorrection = true,
): number {
  if (!messages || messages.length === 0) return 0;

  let total = 0;
  for (const message of messages) {
    total += 4; // service tokens per message
    total += countTokens(message["role"] ?? "", false);

    const content = message["content"];
    if (content) {
      if (typeof content === "string") {
        total += countTokens(content, false);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === "object") {
            const itemType = item["type"];
            if (itemType === "text") {
              total += countTokens(item["text"] ?? "", false);
            } else if (itemType === "image_url" || itemType === "image") {
              total += 100;
            } else if (itemType === "tool_use") {
              total += countTokens(item["id"] ?? "", false);
              total += countTokens(item["name"] ?? "", false);
              total += countTokens(JSON.stringify(item["input"] ?? {}), false);
            } else if (itemType === "tool_result") {
              total += countTokens(item["tool_use_id"] ?? "", false);
              if (item["is_error"] != null) {
                total += countTokens(String(item["is_error"]), false);
              }
              const trContent = item["content"];
              if (typeof trContent === "string") {
                total += countTokens(trContent, false);
              } else if (Array.isArray(trContent)) {
                for (const block of trContent) {
                  if (block && typeof block === "object") {
                    const rType = block["type"];
                    if (rType === "text") {
                      total += countTokens(block["text"] ?? "", false);
                    } else if (rType === "image_url" || rType === "image") {
                      total += 100;
                    }
                  } else {
                    total += countTokens(String(block), false);
                  }
                }
              } else if (trContent != null) {
                total += countTokens(String(trContent), false);
              }
            } else {
              total += countTokens(JSON.stringify(item), false);
            }
          } else {
            total += countTokens(String(item), false);
          }
        }
      }
    }

    const toolCalls = message["tool_calls"];
    if (toolCalls) {
      for (const tc of toolCalls) {
        total += 4;
        const func = tc["function"] ?? {};
        total += countTokens(func["name"] ?? "", false);
        total += countTokens(func["arguments"] ?? "", false);
      }
    }

    if (message["tool_call_id"]) {
      total += countTokens(message["tool_call_id"], false);
    }
  }

  total += 3; // final service tokens
  return applyClaudeCorrection ? Math.floor(total * CLAUDE_CORRECTION_FACTOR) : total;
}

/** Count tokens in tool definitions (OpenAI standard + Anthropic/flat shapes). */
export function countToolsTokens(
  tools: AnyRecord[] | null | undefined,
  applyClaudeCorrection = true,
): number {
  if (!tools || tools.length === 0) return 0;

  let total = 0;
  for (const tool of tools) {
    total += 4;
    const payload =
      tool["type"] === "function" && tool["function"] && typeof tool["function"] === "object"
        ? tool["function"]
        : tool;

    total += countTokens(payload["name"] ?? "", false);
    total += countTokens(payload["description"] ?? "", false);

    const params = payload["input_schema"] ?? payload["parameters"];
    if (params != null) {
      total += countTokens(JSON.stringify(params), false);
    }
  }

  return applyClaudeCorrection ? Math.floor(total * CLAUDE_CORRECTION_FACTOR) : total;
}

/** Count tokens in a system prompt (string or Anthropic block list). */
export function countSystemTokens(
  systemPrompt: unknown,
  applyClaudeCorrection = true,
): number {
  if (!systemPrompt) return 0;

  let total = 0;
  if (typeof systemPrompt === "string") {
    total += countTokens(systemPrompt, false);
  } else if (Array.isArray(systemPrompt)) {
    for (const block of systemPrompt) {
      if (block && typeof block === "object") {
        total += countTokens((block as AnyRecord)["text"] ?? "", false);
        if ((block as AnyRecord)["cache_control"] != null) {
          total += countTokens(JSON.stringify((block as AnyRecord)["cache_control"]), false);
        }
      } else {
        total += countTokens(String(block), false);
      }
    }
  } else {
    total += countTokens(String(systemPrompt), false);
  }

  return applyClaudeCorrection ? Math.floor(total * CLAUDE_CORRECTION_FACTOR) : total;
}

export interface RequestTokenEstimate {
  messagesTokens: number;
  toolsTokens: number;
  systemTokens: number;
  totalTokens: number;
}

/** Estimate total request tokens (messages + tools + system). */
export function estimateRequestTokens(
  messages: AnyRecord[],
  tools?: AnyRecord[] | null,
  systemPrompt?: unknown,
  applyClaudeCorrection = true,
): RequestTokenEstimate {
  const messagesTokens = countMessageTokens(messages, applyClaudeCorrection);
  const toolsTokens = countToolsTokens(tools, applyClaudeCorrection);
  const systemTokens = countSystemTokens(systemPrompt, applyClaudeCorrection);
  return {
    messagesTokens,
    toolsTokens,
    systemTokens,
    totalTokens: messagesTokens + toolsTokens + systemTokens,
  };
}
