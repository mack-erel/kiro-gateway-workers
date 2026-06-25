/**
 * Utility functions: Kiro request headers, machine fingerprint, ID generation.
 * Ported from the Python `kiro/utils.py`.
 */
import type { KiroAuthContext } from "../types";

/** Hex-encode an ArrayBuffer. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex digest of a UTF-8 string (Web Crypto, async). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

// Cloudflare Workers has no hostname/username, so the machine fingerprint is a
// stable constant rather than host-derived. It identifies this gateway build in
// the User-Agent and must NOT vary per request (Kiro may correlate it).
const FINGERPRINT_SEED = "kiro-gateway-workers";
let _fingerprintCache: string | null = null;

/** Stable machine fingerprint (SHA-256 hex of a fixed seed), computed once. */
export async function getMachineFingerprint(): Promise<string> {
  if (_fingerprintCache === null) {
    _fingerprintCache = await sha256Hex(FINGERPRINT_SEED);
  }
  return _fingerprintCache;
}

/**
 * Build headers for a Kiro API request. Mirrors `get_kiro_headers` in the
 * original gateway, including the `tokentype: API_KEY` header that tells Kiro
 * the bearer token is a ksk_ API key (required for passthrough).
 */
export function getKiroHeaders(
  auth: KiroAuthContext,
  token: string,
): Record<string, string> {
  const fp = auth.fingerprint;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target":
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/win32#10.0.19044 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.27 m/E KiroIDE-0.7.45-${fp}`,
    "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${fp}`,
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-invocation-id": crypto.randomUUID(),
    "amz-sdk-request": "attempt=1; max=3",
  };

  // API-key auth requires Kiro to know the bearer token is a ksk_ API key.
  if (auth.authType === "api_key") {
    headers["tokentype"] = "API_KEY";
  }

  return headers;
}

/** uuid4 without dashes — matches Python's `uuid.uuid4().hex` (32 hex chars). */
function uuidHex(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Generate a chat completion ID: `chatcmpl-{uuid_hex}`. */
export function generateCompletionId(): string {
  return `chatcmpl-${uuidHex()}`;
}

/**
 * Generate a conversation ID. The passthrough path always calls this without
 * arguments, which (as in the original) returns a random UUID. The stable
 * history-hash variant is unused in passthrough and intentionally omitted.
 */
export function generateConversationId(): string {
  return crypto.randomUUID();
}

/** Generate a tool call ID: `call_{uuid_hex[:8]}`. */
export function generateToolCallId(): string {
  return `call_${uuidHex().slice(0, 8)}`;
}

/**
 * Split a string into chunks of at most `size` Unicode code points.
 *
 * A naive `str.slice(i, i + size)` cuts on UTF-16 code-unit boundaries, which
 * can split a surrogate pair (emoji, many CJK extension chars, etc.) in half —
 * the two halves then decode to U+FFFD replacement characters on the wire,
 * corrupting the text. Iterating with the string iterator yields whole code
 * points, so chunk boundaries never fall inside a surrogate pair.
 *
 * Note: this preserves code points, not grapheme clusters — a chunk boundary
 * can still fall between a base character and a combining mark. That is
 * cosmetically harmless (it re-composes when concatenated client-side) and
 * avoids pulling in Intl.Segmenter; the goal here is only to stop producing
 * invalid UTF-16/UTF-8.
 */
export function chunkByCodePoints(text: string, size: number): string[] {
  if (size <= 0) return text ? [text] : [];
  const chunks: string[] = [];
  let current = "";
  let count = 0;
  for (const cp of text) {
    current += cp;
    count += 1;
    if (count >= size) {
      chunks.push(current);
      current = "";
      count = 0;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
