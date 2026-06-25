import { describe, it, expect } from "vitest";
import {
  streamKiroToOpenAI,
  collectOpenAIResponse,
  type OpenAIStreamArgs,
} from "../src/streaming/openai";
import {
  streamKiroToAnthropic,
  collectAnthropicResponse,
  type AnthropicStreamArgs,
} from "../src/streaming/anthropic";
import { loadConfig } from "../src/config";
import type { KiroAuthContext } from "../src/types";

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

function parseAnthropicSse(raw: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const e = trimmed.match(/^event: (.+)$/m);
    const d = trimmed.match(/^data: (.+)$/m);
    if (e && d) events.push({ event: e[1], data: JSON.parse(d[1]) });
  }
  return events;
}

function openaiArgs(body: ReadableStream<Uint8Array>, stop?: any): OpenAIStreamArgs {
  const config = loadConfig({});
  return {
    body,
    model: "claude-sonnet-4.5",
    modelCache,
    auth,
    config,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    stop,
  };
}

function anthropicArgs(body: ReadableStream<Uint8Array>, stopSequences?: string[]): AnthropicStreamArgs {
  const config = loadConfig({});
  return {
    body,
    model: "claude-sonnet-4.5",
    modelCache,
    auth,
    config,
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    stopSequences,
  };
}

async function drainOpenai(args: OpenAIStreamArgs): Promise<string> {
  let out = "";
  for await (const c of streamKiroToOpenAI(args)) out += c;
  return out;
}
async function drainAnthropic(args: AnthropicStreamArgs): Promise<string> {
  let out = "";
  for await (const c of streamKiroToAnthropic(args)) out += c;
  return out;
}

describe("OpenAI streaming — stop sequences", () => {
  it("truncates content at the stop sequence and reports finish_reason stop", async () => {
    const body = fakeKiroBody([
      '{"content":"Hello "}',
      '{"content":"STOP rest"}',
      '{"contextUsagePercentage":5}',
    ]);
    const chunks = parseOpenAiSse(await drainOpenai(openaiArgs(body, "STOP")));
    const text = chunks
      .map((c) => c.choices[0].delta.content)
      .filter((x) => typeof x === "string")
      .join("");
    expect(text).toBe("Hello ");
    const final = chunks.find((c) => c.choices[0].finish_reason);
    expect(final.choices[0].finish_reason).toBe("stop");
  });

  it("handles a stop sequence split across chunks", async () => {
    const body = fakeKiroBody([
      '{"content":"keep ST"}',
      '{"content":"OP drop"}',
      '{"contextUsagePercentage":5}',
    ]);
    const chunks = parseOpenAiSse(await drainOpenai(openaiArgs(body, ["STOP"])));
    const text = chunks
      .map((c) => c.choices[0].delta.content)
      .filter((x) => typeof x === "string")
      .join("");
    expect(text).toBe("keep ");
  });

  it("does not truncate when no stop sequence matches", async () => {
    const body = fakeKiroBody(['{"content":"full text"}', '{"contextUsagePercentage":5}']);
    const chunks = parseOpenAiSse(await drainOpenai(openaiArgs(body, "NOPE")));
    const text = chunks
      .map((c) => c.choices[0].delta.content)
      .filter((x) => typeof x === "string")
      .join("");
    expect(text).toBe("full text");
  });

  it("collect path applies stop", async () => {
    const body = fakeKiroBody([
      '{"content":"abc DONE xyz"}',
      '{"contextUsagePercentage":5}',
    ]);
    const resp = await collectOpenAIResponse(openaiArgs(body, "DONE"));
    expect(resp.choices[0].message.content).toBe("abc ");
    expect(resp.choices[0].finish_reason).toBe("stop");
  });
});

describe("Anthropic streaming — stop sequences", () => {
  it("truncates and reports stop_reason stop_sequence + stop_sequence value", async () => {
    const body = fakeKiroBody([
      '{"content":"Hello "}',
      '{"content":"END now"}',
      '{"contextUsagePercentage":5}',
    ]);
    const events = parseAnthropicSse(await drainAnthropic(anthropicArgs(body, ["END"])));
    const text = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(text).toBe("Hello ");
    const delta = events.find((e) => e.event === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("stop_sequence");
    expect(delta.data.delta.stop_sequence).toBe("END");
  });

  it("collect path applies stop_sequences", async () => {
    const body = fakeKiroBody(['{"content":"keep STOP cut"}', '{"contextUsagePercentage":5}']);
    const resp = await collectAnthropicResponse(anthropicArgs(body, ["STOP"]));
    const textBlock = resp.content.find((b: any) => b.type === "text");
    expect(textBlock.text).toBe("keep ");
    expect(resp.stop_reason).toBe("stop_sequence");
    expect(resp.stop_sequence).toBe("STOP");
  });
});
