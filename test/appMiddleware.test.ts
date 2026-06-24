import { describe, it, expect } from "vitest";
import app from "../src/index";

/**
 * Integration tests for the global middleware in src/index.ts: the
 * Content-Length body-size guard and the CORS policy. These exercise the Hono
 * app directly via app.request(), without hitting any upstream.
 */

const OVER_LIMIT = String(10 * 1024 * 1024 + 1); // one byte past the 10 MB cap
const UNDER_LIMIT = String(1024);

describe("body-size guard (Content-Length)", () => {
  it("rejects an oversized OpenAI request with 413 in OpenAI error shape", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": OVER_LIMIT },
      body: "{}",
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/exceeds/);
  });

  it("rejects an oversized Anthropic request with 413 in Anthropic error shape", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": OVER_LIMIT },
      body: "{}",
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("does not 413 a normally-sized request (guard lets it through)", async () => {
    // No upstream is reached — the request fails auth (401) — but crucially it
    // is NOT blocked by the size guard.
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": UNDER_LIMIT },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).not.toBe(413);
  });
});

describe("CORS policy", () => {
  it("allows any origin but does NOT set Allow-Credentials", async () => {
    const res = await app.request("/", {
      method: "GET",
      headers: { origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // credentials:true was removed — the header must be absent (browsers reject
    // the "*" + credentials combination).
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers preflight OPTIONS", async () => {
    const res = await app.request("/v1/messages", {
      method: "OPTIONS",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
