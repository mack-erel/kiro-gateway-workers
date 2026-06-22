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
 *  - The model list is additionally cached in KV (wired up in the aux-features
 *    commit) so cold isolates avoid re-fetching from the management endpoint.
 */
import type { KiroAuthContext } from "../types";
import { sha256Hex } from "../lib/utils";
import { createKiroAuthContext } from "./kiroAuth";

/** Cached, request-independent state derived from a client API key. */
export interface PassthroughSession {
  authContext: KiroAuthContext;
  /** Resolved model IDs for this key. Populated by aux-features model discovery. */
  modelIds: string[] | null;
}

const _sessions = new Map<string, PassthroughSession>();

/** Short, log-safe cache key for an API key. */
export async function sessionKeyHash(apiKey: string): Promise<string> {
  return (await sha256Hex(apiKey)).slice(0, 16);
}

/**
 * Get or create a cached passthrough session for a client API key.
 *
 * Model-list discovery is layered on in the aux-features commit; for now a new
 * session starts with `modelIds = null` (callers fall back to the static list).
 */
export async function getPassthroughSession(
  apiKey: string,
  region: string,
): Promise<PassthroughSession> {
  const hash = await sessionKeyHash(apiKey);

  let session = _sessions.get(hash);
  if (!session) {
    const authContext = await createKiroAuthContext(apiKey, region);
    session = { authContext, modelIds: null };
    _sessions.set(hash, session);
  }
  return session;
}
