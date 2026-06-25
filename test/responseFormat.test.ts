import { describe, it, expect } from "vitest";
import {
  buildResponseFormatInstruction,
  buildOpenAIKiroPayload,
} from "../src/converters/openai";
import { loadConfig } from "../src/config";

describe("buildResponseFormatInstruction", () => {
  it("returns empty for no response_format or text mode", () => {
    expect(buildResponseFormatInstruction(null as any)).toBe("");
    expect(buildResponseFormatInstruction(undefined as any)).toBe("");
    expect(buildResponseFormatInstruction({ type: "text" } as any)).toBe("");
  });

  it("instructs a single JSON object for json_object mode", () => {
    const s = buildResponseFormatInstruction({ type: "json_object" } as any);
    expect(s).toMatch(/valid JSON object/i);
    expect(s).toMatch(/markdown/i); // explicitly bans code fences
  });

  it("includes the schema for json_schema mode", () => {
    const s = buildResponseFormatInstruction({
      type: "json_schema",
      json_schema: { name: "Foo", schema: { type: "object" } },
    } as any);
    expect(s).toMatch(/JSON schema/i);
    expect(s).toContain('"Foo"');
  });
});

describe("buildOpenAIKiroPayload — response_format injection", () => {
  it("appends the JSON instruction to the system prompt sent to Kiro", async () => {
    const config = loadConfig({});
    const { payload } = await buildOpenAIKiroPayload(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "system", content: "Base instructions." },
          { role: "user", content: "give me data" },
        ],
        response_format: { type: "json_object" },
      } as any,
      "conv-1",
      "",
      config,
    );
    // With empty history the system prompt is prepended to the current message.
    const current = payload.conversationState.currentMessage.userInputMessage.content;
    expect(current).toMatch(/Base instructions\./);
    expect(current).toMatch(/valid JSON object/i);
  });

  it("does not alter the prompt for text mode", async () => {
    const config = loadConfig({});
    const { payload } = await buildOpenAIKiroPayload(
      {
        model: "claude-sonnet-4.5",
        messages: [
          { role: "system", content: "Base." },
          { role: "user", content: "hi" },
        ],
        response_format: { type: "text" },
      } as any,
      "conv-2",
      "",
      config,
    );
    const current = payload.conversationState.currentMessage.userInputMessage.content;
    expect(current).not.toMatch(/valid JSON object/i);
  });
});
