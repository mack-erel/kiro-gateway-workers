/**
 * Module-level structured logging.
 *
 * The per-request {@link AuditLogger} (lib/auditLog) is the right tool inside
 * route handlers, but converters, parsers, and other request-independent code
 * have no access to it. This helper gives them the same one-line structured
 * JSON shape (captured by Workers Logs / tail / Logpush) so that things which
 * used to fail silently — dropped images, unparseable tool arguments, skipped
 * malformed events — leave a trace that can be reviewed and acted on later.
 *
 * Keep payloads small and free of secrets / raw prompt bodies: these lines are
 * always emitted (not gated behind DEBUG_BODIES).
 */

/** Emit a structured warning line: `{event, ...fields}` as one JSON record. */
export function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

/** Emit a structured error line: `{event, ...fields}` as one JSON record. */
export function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}
