import { describe, it, expect } from "vitest";
import {
  streamKiroToOpenAI,
  collectOpenAIResponse,
  type OpenAIStreamArgs,
} from "../src/streaming/openai";
import { loadConfig } from "../src/config";
import type { KiroAuthContext } from "../src/types";

/** Build a fake Kiro upstream body from raw event-stream text (see anthropic test). */
function fakeKiroBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const modelCache = { getMaxInputTokens: () => 200000 };
const auth = { apiHost: "https://example.invalid", token: "ksk_test" } as unknown as KiroAuthContext;

/** Parse `data: {…}` SSE lines into objects (skips the [DONE] sentinel). */
function parseOpenAiSse(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    out.push(JSON.parse(payload));
  }
  return out;
}

function baseArgs(body: ReadableStream<Uint8Array>): OpenAIStreamArgs {
  const config = loadConfig({});
  return {
    body,
    model: "claude-sonnet-4.5",
    modelCache,
    auth,
    config,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
  };
}

async function drain(args: OpenAIStreamArgs): Promise<string> {
  let out = "";
  for await (const chunk of streamKiroToOpenAI(args)) out += chunk;
  return out;
}

describe("streamKiroToOpenAI — SSE chunk format", () => {
  it("attaches role on the first chunk and reconstructs content, ending with [DONE]", async () => {
    const body = fakeKiroBody([
      '{"content":"Hello"}',
      '{"content":", world"}',
      '{"contextUsagePercentage":10}',
    ]);
    const raw = await drain(baseArgs(body));

    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const chunks = parseOpenAiSse(raw);
    // First delta carries role: assistant.
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    // All objects are chat.completion.chunk.
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);

    const text = chunks
      .map((c) => c.choices[0].delta.content)
      .filter((x) => typeof x === "string")
      .join("");
    expect(text).toBe("Hello, world");
  });

  it("maps a normally-completed stream to finish_reason stop", async () => {
    const body = fakeKiroBody(['{"content":"done"}', '{"contextUsagePercentage":5}']);
    const chunks = parseOpenAiSse(await drain(baseArgs(body)));
    const final = chunks.find((c) => c.choices[0].finish_reason);
    expect(final.choices[0].finish_reason).toBe("stop");
    expect(final.usage).toBeDefined();
  });

  it("maps content with no completion signal to finish_reason length (truncation)", async () => {
    const body = fakeKiroBody(['{"content":"cut off"}']);
    const chunks = parseOpenAiSse(await drain(baseArgs(body)));
    const final = chunks.find((c) => c.choices[0].finish_reason);
    expect(final.choices[0].finish_reason).toBe("length");
  });

  it("emits reasoning_content deltas for thinking when fake-reasoning is on", async () => {
    const body = fakeKiroBody([
      '{"content":"<thinking>step one</thinking>"}',
      '{"content":"answer"}',
      '{"contextUsagePercentage":7}',
    ]);
    const chunks = parseOpenAiSse(await drain(baseArgs(body)));
    const reasoning = chunks
      .map((c) => c.choices[0].delta.reasoning_content)
      .filter((x) => typeof x === "string")
      .join("");
    expect(reasoning).toContain("step one");
  });
});

describe("collectOpenAIResponse — non-streaming", () => {
  it("assembles a chat.completion with accumulated content", async () => {
    const body = fakeKiroBody([
      '{"content":"Hello"}',
      '{"content":" there"}',
      '{"contextUsagePercentage":10}',
    ]);
    const resp = await collectOpenAIResponse(baseArgs(body));
    expect(resp.object).toBe("chat.completion");
    expect(resp.choices[0].message.role).toBe("assistant");
    expect(resp.choices[0].message.content).toBe("Hello there");
    expect(resp.choices[0].finish_reason).toBe("stop");
  });
});
