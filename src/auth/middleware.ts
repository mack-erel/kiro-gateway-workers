/**
 * Client authentication for the passthrough gateway.
 *
 * Mirrors the Python `verify_api_key` / `verify_anthropic_api_key`:
 *  - A `ksk_…` value (in `Authorization: Bearer` or `x-api-key`) is the client's
 *    own Kiro API key → passthrough mode.
 *  - Otherwise the value must equal the configured PROXY_API_KEY (optional
 *    legacy/server gate). If no PROXY_API_KEY is set, only ksk_ is accepted.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/** Result of a successful authentication. */
export interface AuthResult {
  /** The bearer token: a ksk_ API key (passthrough) or the PROXY_API_KEY. */
  token: string;
  /** True when the token is a client-supplied ksk_ key (passthrough mode). */
  isPassthrough: boolean;
}

/** Extract a candidate token from `Authorization: Bearer` and/or `x-api-key`. */
function extractToken(
  c: Context,
  acceptXApiKey: boolean,
): string | null {
  const authHeader = c.req.header("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  if (acceptXApiKey) {
    const xApiKey = c.req.header("x-api-key");
    if (xApiKey) return xApiKey;
  }
  return null;
}

/**
 * Authenticate the request. Returns the token + mode, or throws 401.
 *
 * @param acceptXApiKey Accept the `x-api-key` header (Anthropic endpoints).
 * @param proxyApiKey   Optional server gate; ksk_ always works regardless.
 */
export function authenticate(
  c: Context,
  acceptXApiKey: boolean,
  proxyApiKey: string | null,
): AuthResult {
  const token = extractToken(c, acceptXApiKey);

  if (!token) {
    throw new HTTPException(401, { message: "Invalid or missing API Key" });
  }

  // Passthrough mode: client supplies its own Kiro API key.
  if (token.startsWith("ksk_")) {
    return { token, isPassthrough: true };
  }

  // Legacy/server mode: validate against the configured proxy key.
  if (proxyApiKey && token === proxyApiKey) {
    return { token, isPassthrough: false };
  }

  throw new HTTPException(401, { message: "Invalid or missing API Key" });
}
