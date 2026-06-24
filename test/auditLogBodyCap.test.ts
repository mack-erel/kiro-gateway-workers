import { describe, it, expect, vi, afterEach } from "vitest";
import { AuditLogger } from "../src/lib/auditLog";
import { loadConfig } from "../src/config";

/**
 * The DEBUG_BODIES body cap: a single full conversation body must not blow the
 * Workers 256 KB per-request log budget (which would suppress all later
 * lifecycle/stream logs). Bodies over the cap are logged as a truncated preview.
 */

function makeLogger(overrides: Record<string, string> = {}) {
  // Bodies are gated on DEBUG_BODIES; set a small cap to exercise truncation.
  const config = loadConfig({ DEBUG_BODIES: "true", ...overrides });
  return new AuditLogger(config);
}

/** Capture console.log lines emitted during fn(), parsed as JSON records. */
function captureLogs(fn: () => void): any[] {
  const lines: any[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: any) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push(line);
    }
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("AuditLogger body cap (DEBUG_BODIES)", () => {
  it("passes small bodies through verbatim", () => {
    const logger = makeLogger({ DEBUG_BODY_MAX_CHARS: "8192" });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const logs = captureLogs(() => logger.requestBody(body));
    const rec = logs.find((l) => l.event === "request.body");
    expect(rec).toBeDefined();
    expect(rec.body).toEqual(body);
    expect(rec.body._truncated).toBeUndefined();
  });

  it("truncates oversized bodies to a preview with metadata", () => {
    const logger = makeLogger({ DEBUG_BODY_MAX_CHARS: "100" });
    const big = "x".repeat(5000);
    const logs = captureLogs(() => logger.responseBody({ text: big }));
    const rec = logs.find((l) => l.event === "response.body");
    expect(rec).toBeDefined();
    expect(rec.body._truncated).toBe(true);
    expect(rec.body.totalChars).toBeGreaterThan(5000);
    expect(rec.body.preview.length).toBe(100);
  });

  it("keeps each capped body well under the 256 KB log budget", () => {
    const logger = makeLogger({ DEBUG_BODY_MAX_CHARS: "8192" });
    const huge = "y".repeat(2 * 1024 * 1024); // 2 MB body
    const logs = captureLogs(() => {
      logger.requestBody({ a: huge });
      logger.kiroPayload({ b: huge });
      logger.responseBody({ c: huge });
    });
    // The three serialized records together must stay small enough that the
    // per-request budget isn't blown by body logging alone.
    const totalChars = logs.reduce((n, l) => n + JSON.stringify(l).length, 0);
    expect(totalChars).toBeLessThan(64 * 1024);
  });

  it("emits nothing when DEBUG_BODIES is off", () => {
    const config = loadConfig({ DEBUG_BODIES: "false" });
    const logger = new AuditLogger(config);
    const logs = captureLogs(() => logger.requestBody({ big: "x".repeat(5000) }));
    expect(logs.find((l) => l.event === "request.body")).toBeUndefined();
  });
});
