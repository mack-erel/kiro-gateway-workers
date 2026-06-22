/**
 * Shared internal types used across converters, streaming, and routes.
 *
 * The gateway converts OpenAI/Anthropic requests into a provider-neutral
 * "Unified" representation, builds the Kiro payload from it, then parses the
 * Kiro response stream into {@link KiroEvent}s before re-emitting OpenAI or
 * Anthropic output.
 */

// ============================================================================
// Unified request representation (provider-neutral)
// ============================================================================

/** A tool call made by the assistant, in unified form. */
export interface UnifiedToolCall {
  id: string;
  name: string;
  /** Arguments as a JSON string (OpenAI style) or object; normalized later. */
  arguments: string;
}

/** A tool result supplied back by the user/runtime. */
export interface UnifiedToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** An image attachment in unified form (base64 only; URLs are unsupported). */
export interface UnifiedImage {
  mediaType: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
}

/** A single conversation message in unified form. */
export interface UnifiedMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: UnifiedToolCall[];
  toolResults?: UnifiedToolResult[];
  images?: UnifiedImage[];
}

/** A tool definition in unified form. */
export interface UnifiedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Extended-thinking configuration extracted from the request. */
export interface ThinkingConfig {
  enabled: boolean;
  /** Token budget; null means "use the configured default". */
  budgetTokens: number | null;
}

// ============================================================================
// Kiro response stream events
// ============================================================================

export type KiroEventType =
  | "content"
  | "thinking"
  | "tool_use"
  | "usage"
  | "context_usage"
  | "error";

/** A normalized event emitted by the Kiro stream parser. */
export interface KiroEvent {
  type: KiroEventType;
  content?: string;
  thinkingContent?: string;
  toolUse?: { name: string; toolUseId: string; arguments: string };
  usage?: Record<string, unknown>;
  contextUsagePercentage?: number;
  isFirstThinkingChunk?: boolean;
  isLastThinkingChunk?: boolean;
}

// ============================================================================
// Auth context (passthrough)
// ============================================================================

/**
 * Minimal auth context for a passthrough request. Mirrors the subset of the
 * Python KiroAuthManager that {@link import("./lib/utils").getKiroHeaders}
 * actually reads — the bearer token, the auth type, the machine fingerprint,
 * and the resolved upstream hosts.
 */
export interface KiroAuthContext {
  /** The client-supplied ksk_ key, used directly as the bearer token. */
  token: string;
  /** Always "api_key" for passthrough. */
  authType: "api_key";
  fingerprint: string;
  apiHost: string;
  qHost: string;
  managementHost: string;
}
