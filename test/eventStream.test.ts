import { describe, it, expect } from "vitest";
import {
  findMatchingBrace,
  parseBracketToolCalls,
  deduplicateToolCalls,
  diagnoseJsonTruncation,
  AwsEventStreamParser,
  type ParsedToolCall,
} from "../src/parsers/eventStream";

const enc = (s: string) => new TextEncoder().encode(s);

describe("findMatchingBrace", () => {
  it("finds the closing brace of a flat object", () => {
    expect(findMatchingBrace('{"a": 1}', 0)).toBe(7);
  });
  it("handles nested objects", () => {
    expect(findMatchingBrace('{"a": {"b": 1}}', 0)).toBe(14);
  });
  it("ignores braces inside strings", () => {
    expect(findMatchingBrace('{"a": "{}"}', 0)).toBe(10);
  });
  it("ignores escaped quotes inside strings", () => {
    const s = '{"a": "x\\"{ }"}';
    expect(findMatchingBrace(s, 0)).toBe(s.length - 1);
  });
  it("returns -1 when unterminated", () => {
    expect(findMatchingBrace('{"a": 1', 0)).toBe(-1);
  });
});

describe("parseBracketToolCalls", () => {
  it("extracts a [Called ...] tool call", () => {
    const calls = parseBracketToolCalls('[Called get_weather with args: {"city": "London"}]');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: "London" });
  });
  it("returns [] when no marker present", () => {
    expect(parseBracketToolCalls("just some text")).toEqual([]);
  });
});

describe("deduplicateToolCalls", () => {
  it("keeps the call with richer arguments for the same id", () => {
    const calls: ParsedToolCall[] = [
      { id: "1", type: "function", function: { name: "f", arguments: "{}" } },
      { id: "1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
    ];
    const out = deduplicateToolCalls(calls);
    expect(out).toHaveLength(1);
    expect(out[0].function.arguments).toBe('{"a":1}');
  });
  it("removes exact name+arguments duplicates", () => {
    const calls: ParsedToolCall[] = [
      { id: "1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
      { id: "2", type: "function", function: { name: "f", arguments: '{"a":1}' } },
    ];
    expect(deduplicateToolCalls(calls)).toHaveLength(1);
  });
});

describe("diagnoseJsonTruncation", () => {
  it("flags missing closing brace as truncated", () => {
    const info = diagnoseJsonTruncation('{"a": "very long valu');
    expect(info.isTruncated).toBe(true);
  });
  it("treats balanced JSON as malformed (not truncated)", () => {
    const info = diagnoseJsonTruncation('{"a": bad}');
    expect(info.isTruncated).toBe(false);
    expect(info.reason).toBe("malformed JSON");
  });
});

describe("AwsEventStreamParser", () => {
  it("scrapes content events and dedups repeats", () => {
    const p = new AwsEventStreamParser();
    const events = p.feed(enc('garbage{"content":"Hello"}more{"content":"Hello"}{"content":" world"}'));
    const contents = events.filter((e) => e.type === "content").map((e) => (e as any).data);
    expect(contents).toEqual(["Hello", " world"]); // duplicate "Hello" dropped
  });

  it("handles a JSON object split across two chunks", () => {
    const p = new AwsEventStreamParser();
    const first = p.feed(enc('{"content":"par'));
    expect(first).toHaveLength(0); // incomplete — buffered
    const second = p.feed(enc('tial"}'));
    expect(second).toEqual([{ type: "content", data: "partial" }]);
  });

  it("accumulates a tool call across start + input + stop events", () => {
    const p = new AwsEventStreamParser();
    p.feed(enc('{"name":"search","toolUseId":"t1","input":{}}'));
    p.feed(enc('{"input":"{\\"q\\":"}'));
    p.feed(enc('{"input":"\\"hi\\"}"}'));
    p.feed(enc('{"stop":true}'));
    const calls = p.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("search");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ q: "hi" });
  });

  it("restores aliased tool names via the reverse map", () => {
    const p = new AwsEventStreamParser({ alias_abc: "the_original_long_name" });
    p.feed(enc('{"name":"alias_abc","toolUseId":"t1","input":{"x":1},"stop":true}'));
    const calls = p.getToolCalls();
    expect(calls[0].function.name).toBe("the_original_long_name");
  });

  it("emits usage and context_usage events", () => {
    const p = new AwsEventStreamParser();
    const ev = p.feed(enc('{"usage":5}{"contextUsagePercentage":42.5}'));
    expect(ev).toContainEqual({ type: "usage", data: 5 });
    expect(ev).toContainEqual({ type: "context_usage", data: 42.5 });
  });
});
