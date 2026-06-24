/**
 * Structured audit logging.
 *
 * Emits one-line JSON records via console (captured by Workers Logs / tail /
 * Logpush). Three tiers:
 *  - Level 1 (always on): request lifecycle — received, auth, upstream
 *    request/response, completion, error.
 *  - Level 2 (DEBUG_STREAM_EVENTS): one record per KiroEvent.
 *  - Level 3 (DEBUG_BODIES): request / Kiro-payload / response bodies.
 *
 * Security: never logs the raw ksk_ key — only a short SHA-256 hash. Body
 * logging is opt-in and may contain prompt PII, so it is off by default.
 */
import type { Config } from "../config";
import { sha256Hex } from "./utils";

/**
 * LOG_LEVEL → numeric severity. Acts as a master verbosity gate: an event is
 * emitted only when its severity is >= the configured level. Lifecycle events
 * are INFO; errors are ERROR. DEBUG is reserved for future per-event tuning.
 */
const SEVERITY: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
};

/**
 * Per-body cap for DEBUG_BODIES logging. Workers enforces a hard 256 KB total
 * log budget PER REQUEST; a single full conversation body blows past that in one
 * line, which then suppresses all subsequent lifecycle/stream logs for that
 * request. Capping each body to a preview keeps the three body records
 * (request / payload / response ≈ 24 KB total) well inside the budget so the
 * rest of the audit trail survives. Override via DEBUG_BODY_MAX_CHARS.
 */
const DEFAULT_BODY_MAX_CHARS = 8 * 1024;

/**
 * Render a body for logging: serialize to JSON, and if it exceeds `maxChars`,
 * return a structured marker with a head preview instead of the full value.
 * Never throws — unserializable input falls back to String().
 */
function previewBody(body: unknown, maxChars: number): unknown {
  let serialized: string;
  try {
    serialized = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    serialized = String(body);
  }
  if (serialized === undefined) serialized = String(body);
  if (serialized.length <= maxChars) return body;
  return {
    _truncated: true,
    totalChars: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

/** Audit event type tags (the `event` field of each record). */
export type AuditEvent =
  | "request.received"
  | "request.auth"
  | "request.rejected"
  | "upstream.request"
  | "upstream.response"
  | "upstream.retry"
  | "stream.event"
  | "request.body"
  | "kiro.payload"
  | "response.body"
  | "request.completed"
  | "request.error";

/** Per-request audit logger with a stable correlation id. */
export class AuditLogger {
  readonly requestId: string;
  private readonly debugStreamEvents: boolean;
  private readonly debugBodies: boolean;
  private readonly bodyMaxChars: number;
  private readonly startMs: number;
  /** Minimum severity to emit, from LOG_LEVEL (DEBUG<INFO<WARNING<ERROR). */
  private readonly minSeverity: number;

  constructor(config: Config, requestId?: string) {
    this.requestId = requestId ?? crypto.randomUUID();
    this.debugStreamEvents = config.debugStreamEvents;
    this.debugBodies = config.debugBodies;
    this.bodyMaxChars = config.debugBodyMaxChars ?? DEFAULT_BODY_MAX_CHARS;
    this.startMs = Date.now();
    this.minSeverity = SEVERITY[config.logLevel] ?? SEVERITY.INFO;
  }

  /** Milliseconds since this logger (≈ the request) started. */
  private elapsed(): number {
    return Date.now() - this.startMs;
  }

  /**
   * Emit one structured JSON line. Lifecycle events are gated by LOG_LEVEL
   * severity; debug channels pass `bypassLevel` since they have their own
   * explicit opt-in (DEBUG_STREAM_EVENTS / DEBUG_BODIES) that must win.
   */
  private emit(
    event: AuditEvent,
    fields: Record<string, unknown>,
    level: "info" | "error" = "info",
    bypassLevel = false,
  ): void {
    if (!bypassLevel) {
      const severity = level === "error" ? SEVERITY.ERROR : SEVERITY.INFO;
      if (severity < this.minSeverity) return;
    }
    const record = {
      ts: new Date().toISOString(),
      requestId: this.requestId,
      event,
      ...fields,
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else console.log(line);
  }

  // --- Level 1: always on -------------------------------------------------

  /** Request received: method, path, model, streaming flag. */
  received(method: string, path: string, extra: Record<string, unknown> = {}): void {
    this.emit("request.received", { method, path, ...extra });
  }

  /**
   * Auth outcome. The raw key is never logged — only a short hash and mode.
   * @param token  The bearer token (hashed, not stored).
   * @param mode   "passthrough" | "proxy".
   */
  async auth(token: string, mode: string): Promise<void> {
    const keyHash = (await sha256Hex(token)).slice(0, 12);
    this.emit("request.auth", { mode, keyHash });
  }

  /** A rejected request (401/422/etc.) with a reason. */
  rejected(status: number, reason: string): void {
    this.emit("request.rejected", { status, reason });
  }

  /** Upstream request about to be sent. */
  upstreamRequest(url: string, model: string, stream: boolean): void {
    this.emit("upstream.request", { url, model, stream });
  }

  /** Upstream response status (after the request returns). */
  upstreamResponse(status: number): void {
    this.emit("upstream.response", { status });
  }

  /** A first-token-timeout retry attempt. */
  upstreamRetry(attempt: number, maxRetries: number): void {
    this.emit("upstream.retry", { attempt, maxRetries });
  }

  /** Request completed: token usage + stop reason. */
  completed(fields: Record<string, unknown>): void {
    this.emit("request.completed", { elapsedMs: this.elapsed(), ...fields });
  }

  /** An error during processing. */
  error(message: string, extra: Record<string, unknown> = {}): void {
    this.emit("request.error", { elapsedMs: this.elapsed(), message, ...extra }, "error");
  }

  // --- Level 2: DEBUG_STREAM_EVENTS --------------------------------------

  /** One record per KiroEvent. No-op unless DEBUG_STREAM_EVENTS is on. */
  streamEvent(type: string, fields: Record<string, unknown> = {}): void {
    if (!this.debugStreamEvents) return;
    this.emit("stream.event", { kiroEventType: type, ...fields }, "info", true);
  }

  // --- Level 3: DEBUG_BODIES ---------------------------------------------

  /** Log the inbound client request body. No-op unless DEBUG_BODIES is on. */
  requestBody(body: unknown): void {
    if (!this.debugBodies) return;
    this.emit("request.body", { body: previewBody(body, this.bodyMaxChars) }, "info", true);
  }

  /** Log the assembled Kiro payload. No-op unless DEBUG_BODIES is on. */
  kiroPayload(payload: unknown): void {
    if (!this.debugBodies) return;
    this.emit("kiro.payload", { payload: previewBody(payload, this.bodyMaxChars) }, "info", true);
  }

  /** Log the outbound response body. No-op unless DEBUG_BODIES is on. */
  responseBody(body: unknown): void {
    if (!this.debugBodies) return;
    this.emit("response.body", { body: previewBody(body, this.bodyMaxChars) }, "info", true);
  }
}
