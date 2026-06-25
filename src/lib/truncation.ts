/**
 * Truncation recovery + state. Ports `truncation_recovery.py` and
 * `truncation_state.py` into one module.
 *
 * Kiro truncates large tool-call payloads / content mid-stream. We detect this,
 * remember it, and on the NEXT request inject a synthetic tool_result / user
 * message so the model can adapt.
 *
 * ⚠️ Workers limitation — best-effort only. The Python original ran as a single
 * long-lived process, so its in-memory cache reliably bridged request N → N+1.
 * On Workers the state lives in a module-scope Map inside a V8 isolate, and the
 * runtime spins up / discards / load-balances across many isolates: the
 * follow-up request is NOT guaranteed to hit the same isolate that saved the
 * state, so the synthetic recovery message often won't fire. "Workers-safe"
 * here means only that the Map holds plain data and never crashes — NOT that it
 * persists across requests. Making this durable would require external storage
 * (KV / Durable Object), intentionally dropped in favor of the stateless
 * passthrough design. Treat recovery as a bonus when it happens, not a contract.
 */
import { sha256Hex } from "./utils";

// ============================================================================
// Recovery message generation
// ============================================================================

/** Synthetic tool_result describing a truncated tool call (unified form). */
export function generateTruncationToolResult(
  _toolName: string,
  toolUseId: string,
): Record<string, any> {
  const content =
    "[API Limitation] Your tool call was truncated by the upstream API due to output size limits.\n\n" +
    "If the tool result below shows an error or unexpected behavior, this is likely a CONSEQUENCE of the truncation, " +
    "not the root cause. The tool call itself was cut off before it could be fully transmitted.\n\n" +
    "Repeating the exact same operation will be truncated again. Consider adapting your approach.";
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: true };
}

/** Synthetic user message describing content truncation. */
export function generateTruncationUserMessage(): string {
  return (
    "[System Notice] Your previous response was truncated by the API due to " +
    "output size limitations. This is not an error on your part. " +
    "If you need to continue, please adapt your approach rather than repeating the same output."
  );
}

// ============================================================================
// State cache (module-scope, no TTL, one-time retrieval)
// ============================================================================

export interface ToolTruncationInfo {
  toolCallId: string;
  toolName: string;
  truncationInfo: Record<string, any>;
  timestamp: number;
}

export interface ContentTruncationInfo {
  messageHash: string;
  contentPreview: string;
  timestamp: number;
}

const toolTruncationCache = new Map<string, ToolTruncationInfo>();
const contentTruncationCache = new Map<string, ContentTruncationInfo>();

// Bounds for the in-memory caches. Because the follow-up request frequently
// lands on a DIFFERENT isolate (see the module header), saved entries are often
// never retrieved and would otherwise accumulate for the isolate's lifetime.
// We cap both size and age so a hot, long-lived isolate can't grow without
// bound — mirroring the bounded session cache. Entries are evicted oldest-first
// (insertion order via Map) and swept by age on every save.
const MAX_CACHE_ENTRIES = 1000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Drop entries older than the TTL, then evict oldest entries (Map preserves
 * insertion order) until the cache is within the size cap. Run on every save so
 * cleanup cost is amortized and bounded.
 */
function evict<T extends { timestamp: number }>(cache: Map<string, T>): void {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Save truncation info for a tool call (keyed by tool_call_id). */
export function saveToolTruncation(
  toolCallId: string,
  toolName: string,
  truncationInfo: Record<string, any>,
): void {
  toolTruncationCache.set(toolCallId, {
    toolCallId,
    toolName,
    truncationInfo,
    timestamp: Date.now(),
  });
  evict(toolTruncationCache);
}

/** Retrieve and remove tool truncation info (one-time). */
export function getToolTruncation(toolCallId: string): ToolTruncationInfo | null {
  const info = toolTruncationCache.get(toolCallId) ?? null;
  if (info) toolTruncationCache.delete(toolCallId);
  return info;
}

/** Hash of the first 500 chars of content (16 hex), via Web Crypto. */
async function contentHash(content: string): Promise<string> {
  return (await sha256Hex(content.slice(0, 500))).slice(0, 16);
}

/** Save content truncation info (keyed by content hash). Returns the hash. */
export async function saveContentTruncation(content: string): Promise<string> {
  const hash = await contentHash(content);
  contentTruncationCache.set(hash, {
    messageHash: hash,
    contentPreview: content.slice(0, 200),
    timestamp: Date.now(),
  });
  evict(contentTruncationCache);
  return hash;
}

/** Retrieve and remove content truncation info (one-time). */
export async function getContentTruncation(
  content: string,
): Promise<ContentTruncationInfo | null> {
  const hash = await contentHash(content);
  const info = contentTruncationCache.get(hash) ?? null;
  if (info) contentTruncationCache.delete(hash);
  return info;
}

/** Cache sizes (monitoring/debugging). */
export function getCacheStats(): { toolTruncations: number; contentTruncations: number; total: number } {
  return {
    toolTruncations: toolTruncationCache.size,
    contentTruncations: contentTruncationCache.size,
    total: toolTruncationCache.size + contentTruncationCache.size,
  };
}
