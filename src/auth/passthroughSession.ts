/**
 * Passthrough session cache.
 *
 * Caches per-client-key state so we don't rebuild the auth context (and, later,
 * re-discover the model list) on every request. Mirrors the Python
 * `_get_passthrough_session`, keyed by a short SHA-256 hash of the API key so
 * the raw key never becomes a map key.
 *
 * Two-tier design (per the porting plan):
 *  - Module-scope Map holds ONLY plain, request-independent data (auth context,
 *    resolved model list). Never cache request-bound objects (fetch/streams/
 *    AbortController) here — that triggers "Cannot perform I/O on behalf of a
 *    different request" in Workers.
 *  - The cache is bounded: each entry carries a TTL (so a stale model list is
 *    eventually re-discovered) and the map is capped at a maximum entry count
 *    (oldest-inserted evicted first) so a flood of distinct keys can't grow the
 *    isolate's memory without limit.
 */
import type { KiroAuthContext } from "../types";
import { sha256Hex } from "../lib/utils";
import { createKiroAuthContext } from "./kiroAuth";
import { FALLBACK_MODELS, getKiroManagementHost } from "../config";

/** Cached, request-independent state derived from a client API key. */
export interface PassthroughSession {
  authContext: KiroAuthContext;
  /**
   * Live model list discovered from the management endpoint (or the static
   * fallback if discovery failed). Plain data, so it is Workers-safe to cache.
   */
  modelsData: Array<Record<string, any>>;
}

/**
 * Bound on cached sessions. The map holds small plain objects (auth context +
 * model list), so the cap is generous; it exists to stop a flood of distinct
 * keys from growing the isolate's memory without limit. TTL bounds staleness of
 * the discovered model list.
 */
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 1000;

/** Internal cache entry: the session plus its expiry timestamp. */
interface SessionEntry {
  session: PassthroughSession;
  expiresAt: number;
}

const _sessions = new Map<string, SessionEntry>();

/** Short, log-safe cache key for an API key. */
export async function sessionKeyHash(apiKey: string): Promise<string> {
  return (await sha256Hex(apiKey)).slice(0, 16);
}

/**
 * Discover the available model list from the management endpoint.
 *
 * API-key auth (kiro-cli) lists models via ListAvailableModels on
 * `https://management.{region}.kiro.dev` — the runtime host does not serve it.
 * Mirrors `_fetch_models_via_management`. Throws on HTTP/network error so the
 * caller can fall back to the static list.
 */
async function fetchModelsViaManagement(
  apiKey: string,
  region: string,
): Promise<Array<Record<string, any>>> {
  const url = `${getKiroManagementHost(region)}/`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    tokentype: "API_KEY",
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ origin: "AI_EDITOR" }),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`management ListAvailableModels returned ${response.status}`);
    }
    const data = (await response.json()) as Record<string, any>;
    return (data["models"] as Array<Record<string, any>>) ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get or create a cached passthrough session for a client API key.
 *
 * On first use for a key, the model list is discovered from the management
 * endpoint (one-time, then cached). Discovery failure falls back to the static
 * FALLBACK_MODELS so the gateway still works.
 */
export async function getPassthroughSession(
  apiKey: string,
  region: string,
): Promise<PassthroughSession> {
  const hash = await sessionKeyHash(apiKey);

  const existing = _sessions.get(hash);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.session;
  }
  // Expired or missing: drop the stale entry (if any) and rebuild below.
  if (existing) _sessions.delete(hash);

  const authContext = await createKiroAuthContext(apiKey, region);

  let modelsData: Array<Record<string, any>>;
  try {
    const discovered = await fetchModelsViaManagement(apiKey, region);
    modelsData = discovered.length ? discovered : FALLBACK_MODELS;
  } catch (e) {
    console.warn(
      JSON.stringify({
        event: "model.discovery.failed",
        keyHash: hash,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    modelsData = FALLBACK_MODELS;
  }

  const session: PassthroughSession = { authContext, modelsData };

  // Evict the oldest-inserted entry once the cap is reached. Map preserves
  // insertion order, so the first key is the oldest. A re-inserted (refreshed)
  // key moves to the end above via delete + set, so it isn't penalized.
  if (_sessions.size >= MAX_SESSIONS) {
    const oldest = _sessions.keys().next().value;
    if (oldest !== undefined) _sessions.delete(oldest);
  }
  _sessions.set(hash, { session, expiresAt: Date.now() + SESSION_TTL_MS });

  return session;
}
