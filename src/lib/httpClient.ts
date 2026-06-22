/**
 * HTTP client for the Kiro API with retry logic. Port of `http_client.py`,
 * adapted to the Workers global `fetch`.
 *
 * Retries: 403 → (no-op refresh in passthrough) retry; 429/5xx → exponential
 * backoff; network throw → backoff retry. Returns a Web `Response`; for
 * streaming, the caller reads `response.body`.
 *
 * Passthrough note: ksk_ keys don't refresh, so a 403 retry just re-sends the
 * same key (mirrors the Python force_refresh no-op). The caller surfaces a
 * persistent 403 to the client.
 */
import type { KiroAuthContext } from "../types";
import { getKiroHeaders } from "./utils";

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  /** Total retry attempts (defaults to MAX_RETRIES / FIRST_TOKEN_MAX_RETRIES). */
  maxRetries?: number;
  /** Whether this is a streaming request (adds Connection: close). */
  stream?: boolean;
  /** Abort signal for client-cancellation → upstream abort wiring. */
  signal?: AbortSignal;
}

/** Thrown after all retries are exhausted on a transport-level failure. */
export class UpstreamRequestError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "UpstreamRequestError";
    this.statusCode = statusCode;
  }
}

/**
 * POST a JSON payload to Kiro with retry. Returns the raw `Response` (status
 * checked by the caller). `auth.token` is used directly as the bearer (ksk_).
 */
export async function requestWithRetry(
  auth: KiroAuthContext,
  url: string,
  jsonData: Record<string, any>,
  opts: RequestOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const body = JSON.stringify(jsonData);

  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers = getKiroHeaders(auth, auth.token);
      if (opts.stream) headers["Connection"] = "close";

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: opts.signal,
      });

      if (response.status === 200) return response;

      // 403: token issue. In passthrough there's nothing to refresh; retry.
      if (response.status === 403) {
        lastResponse = response;
        continue;
      }

      // 429 / 5xx: backoff and retry, remembering the response.
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        lastResponse = response;
        await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
        continue;
      }

      // Other statuses: return as-is for the caller to handle.
      return response;
    } catch (e) {
      // Don't retry deliberate aborts (client disconnect / first-token timeout).
      if (e instanceof Error && e.name === "AbortError") throw e;
      lastError = e;
      if (attempt < maxRetries - 1) {
        await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
      }
    }
  }

  // Exhausted: prefer returning a remembered 429/5xx/403 for accurate status.
  if (lastResponse !== null) return lastResponse;

  throw new UpstreamRequestError(
    `Kiro request failed after ${maxRetries} attempts: ${String(lastError)}`,
    opts.stream ? 504 : 502,
  );
}
