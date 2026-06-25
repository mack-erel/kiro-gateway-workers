import { describe, it, expect } from "vitest";
import app from "../src/index";

/**
 * Route-level integration tests via app.request() (no upstream reached).
 * Covers: the unsupported /v1/embeddings endpoint, malformed-JSON handling,
 * and non-ksk_ auth rejection on both surfaces.
 *
 * The Workers runtime always supplies `c.env`; app.request() does not, so we
 * pass an explicit (empty) env as the third arg. loadConfig fills defaults for
 * every missing var, which is all these pre-upstream paths need.
 */
const ENV = {} as any;

describe("/v1/embeddings — explicitly unsupported", () => {
  it("returns a 501 in OpenAI error shape", async () => {
    const res = await app.request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", input: "hi" }),
    }, ENV);
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/not supported/i);
  });
});

describe("malformed JSON body → 400 (not a generic 502)", () => {
  it("OpenAI route returns 400 with OpenAI error shape", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ksk_fake",
      },
      body: "{ this is not json",
    }, ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("Anthropic route returns 400 with Anthropic error shape", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "ksk_fake",
      },
      body: "{ not json either",
    }, ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("auth — non-ksk_ token rejected", () => {
  it("OpenAI route returns 401 for a non-passthrough bearer", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-kiro-key",
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    }, ENV);
    expect(res.status).toBe(401);
  });

  it("Anthropic route returns 401 for a non-passthrough x-api-key", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "nope" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    }, ENV);
    expect(res.status).toBe(401);
  });
});

describe("unsupported params — clear 400 instead of silent ignore", () => {
  it("rejects n>1 with a 400", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ksk_fake" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        n: 3,
      }),
    }, ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/n=1/);
  });

  it("rejects logprobs:true with a 400", async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ksk_fake" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        logprobs: true,
      }),
    }, ENV);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/logprobs/i);
  });

  it("allows n=1 and logprobs:false through to the upstream stage", async () => {
    // These are valid; the request proceeds past validation (and fails later
    // only because no real upstream is reachable in tests) — crucially NOT 400.
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ksk_fake" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        n: 1,
        logprobs: false,
      }),
    }, ENV);
    expect(res.status).not.toBe(400);
  });
});
