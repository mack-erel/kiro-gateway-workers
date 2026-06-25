import { describe, it, expect } from "vitest";
import { extractToolUsesFromMessage, buildKiroPayload } from "../src/converters/core";
import { loadConfig } from "../src/config";

describe("extractToolUsesFromMessage — malformed JSON arguments", () => {
  it("falls back to { _raw } instead of throwing on invalid JSON history args", () => {
    // LLM-generated tool args are frequently invalid JSON; a single bad string
    // in history must not throw (which would fail the whole request).
    const toolCalls = [
      { id: "call_1", function: { name: "do_thing", arguments: "{not valid json," } },
    ];
    expect(() => extractToolUsesFromMessage(null, toolCalls)).not.toThrow();
    const uses = extractToolUsesFromMessage(null, toolCalls);
    expect(uses[0].name).toBe("do_thing");
    expect((uses[0].input as any)._raw).toBe("{not valid json,");
  });

  it("parses valid JSON arguments normally", () => {
    const toolCalls = [
      { id: "call_2", function: { name: "f", arguments: '{"x":1}' } },
    ];
    const uses = extractToolUsesFromMessage(null, toolCalls);
    expect((uses[0].input as any).x).toBe(1);
  });

  it("treats empty arguments as {}", () => {
    const toolCalls = [{ id: "call_3", function: { name: "f", arguments: "" } }];
    const uses = extractToolUsesFromMessage(null, toolCalls);
    expect(uses[0].input).toEqual({});
  });
});

describe("buildKiroPayload — tool-name alias collision", () => {
  it("disambiguates two tools whose 64-char aliases would collide", async () => {
    const config = loadConfig({});
    // Two distinct long names sharing the first 51 chars differ in their SHA-1,
    // so normal aliasing keeps them distinct. To force a real collision we'd
    // need a hash clash (infeasible); instead assert that distinct long names
    // map to distinct aliases (no silent merge).
    const longA = "a".repeat(60) + "_one";
    const longB = "a".repeat(60) + "_two";
    const { payload } = await buildKiroPayload({
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "",
      modelId: "claude-sonnet-4.5",
      tools: [
        { name: longA, description: "d", inputSchema: { type: "object", properties: {} } },
        { name: longB, description: "d", inputSchema: { type: "object", properties: {} } },
      ],
      conversationId: "c",
      profileArn: "",
      thinkingConfig: { enabled: false, budgetTokens: null },
      config,
    });
    const tools = payload.conversationState.currentMessage.userInputMessage
      .userInputMessageContext.tools;
    const names = tools.map((t: any) => t.toolSpecification.name);
    expect(new Set(names).size).toBe(names.length); // all unique
    expect(names.every((n: string) => n.length <= 64)).toBe(true);
  });
});
