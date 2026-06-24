import { describe, it, expect } from "vitest";
import {
  streamKiroToAnthropic,
  collectAnthropicResponse,
  type AnthropicStreamArgs,
} from "../src/streaming/anthropic";
import { collectStreamToResult } from "../src/streaming/core";
import { loadConfig } from "../src/config";
import type { KiroAuthContext } from "../src/types";

/**
 * Build a fake Kiro upstream body from raw event-stream text. The AWS event
 * parser scrapes JSON objects (`{"content":"…"}`, `{"contextUsagePercentage":…}`)
 * out of the bytes, so we just concatenate them — optionally split into chunks
 * to exercise the cross-chunk buffering path.
 */
function fakeKiroBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** Minimal token-math stub (full impl lives in lib/cache). */
const modelCache = { getMaxInputTokens: () => 200000 };

/** Minimal auth context — unused on the plain-content path. */
const auth = { apiHost: "https://example.invalid", token: "ksk_test" } as unknown as KiroAuthContext;

/** Drain the SSE generator into the full response string. */
async function drainSse(args: AnthropicStreamArgs): Promise<string> {
  let out = "";
  for await (const chunk of streamKiroToAnthropic(args)) out += chunk;
  return out;
}

/** Parse `event: X\ndata: {…}\n\n` blocks into [type, data] pairs. */
function parseSse(raw: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const eventLine = trimmed.match(/^event: (.+)$/m);
    const dataLine = trimmed.match(/^data: (.+)$/m);
    if (eventLine && dataLine) {
      events.push({ event: eventLine[1], data: JSON.parse(dataLine[1]) });
    }
  }
  return events;
}

function baseArgs(body: ReadableStream<Uint8Array>): AnthropicStreamArgs {
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

describe("streamKiroToAnthropic — SSE golden sequence", () => {
  it("emits message_start → text block → message_delta → message_stop for plain content", async () => {
    const body = fakeKiroBody([
      '{"content":"Hello"}',
      '{"content":", world"}',
      '{"contextUsagePercentage":12.5}',
    ]);
    const events = parseSse(await drainSse(baseArgs(body)));
    const types = events.map((e) => e.event);

    // Ordered envelope.
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types[types.length - 2]).toBe("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");

    // First content block is a text block.
    const firstStart = events.find((e) => e.event === "content_block_start")!;
    expect(firstStart.data.content_block.type).toBe("text");

    // Deltas reconstruct the full text in order.
    const text = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("Hello, world");
  });

  it("ends with stop_reason end_turn when context usage signals normal completion", async () => {
    const body = fakeKiroBody(['{"content":"done"}', '{"contextUsagePercentage":5}']);
    const events = parseSse(await drainSse(baseArgs(body)));
    const delta = events.find((e) => e.event === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("end_turn");
  });

  it("reports max_tokens when content arrives but the stream never signals completion", async () => {
    // No contextUsagePercentage event → stream did not complete normally.
    const body = fakeKiroBody(['{"content":"partial output cut off"}']);
    const events = parseSse(await drainSse(baseArgs(body)));
    const delta = events.find((e) => e.event === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("max_tokens");
  });

  it("surfaces a thinking block before the text block when fake-reasoning is on", async () => {
    const body = fakeKiroBody([
      '{"content":"<thinking>weighing options</thinking>"}',
      '{"content":"final answer"}',
      '{"contextUsagePercentage":8}',
    ]);
    const events = parseSse(await drainSse(baseArgs(body)));

    const starts = events.filter((e) => e.event === "content_block_start");
    expect(starts[0].data.content_block.type).toBe("thinking");
    expect(starts[1].data.content_block.type).toBe("text");

    const thinking = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta")
      .map((e) => e.data.delta.thinking)
      .join("");
    expect(thinking).toContain("weighing options");
  });
});

describe("collectStreamToResult / collectAnthropicResponse — non-streaming", () => {
  it("accumulates content into a single Anthropic message", async () => {
    const body = fakeKiroBody([
      '{"content":"Hello"}',
      '{"content":" there"}',
      '{"contextUsagePercentage":10}',
    ]);
    const config = loadConfig({});
    const resp = await collectAnthropicResponse({
      body,
      model: "claude-sonnet-4.5",
      modelCache,
      auth,
      config,
      firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    });

    expect(resp.type).toBe("message");
    expect(resp.role).toBe("assistant");
    expect(resp.stop_reason).toBe("end_turn");
    const text = resp.content.find((b: any) => b.type === "text");
    expect(text.text).toBe("Hello there");
  });

  it("splits thinking and text into separate content blocks", async () => {
    const body = fakeKiroBody([
      '{"content":"<thinking>hmm</thinking>answer"}',
      '{"contextUsagePercentage":3}',
    ]);
    const result = await collectStreamToResult(body, loadConfig({}), 15000);
    expect(result.thinkingContent).toContain("hmm");
    expect(result.content).toContain("answer");
  });
});
