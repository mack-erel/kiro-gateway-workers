import { describe, it, expect } from "vitest";
import {
  extractTextContent,
  sanitizeJsonSchema,
  convertToolsToKiroFormat,
  shortenToolName,
  buildToolNameReverseMap,
  buildKiroPayload,
  TOOL_NAME_MAX_LENGTH,
} from "../src/converters/core";
import { loadConfig } from "../src/config";
import type { UnifiedMessage } from "../src/types";

const config = loadConfig({});

describe("extractTextContent", () => {
  it("returns a plain string unchanged", () => {
    expect(extractTextContent("hi")).toBe("hi");
  });
  it("joins text blocks and skips images/tool_reference", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "image", source: {} },
      { type: "text", text: "b" },
    ];
    expect(extractTextContent(content)).toBe("ab");
  });
  it("returns empty string for null", () => {
    expect(extractTextContent(null)).toBe("");
  });
});

describe("sanitizeJsonSchema", () => {
  it("drops empty required arrays and additionalProperties", () => {
    const out = sanitizeJsonSchema({
      type: "object",
      required: [],
      additionalProperties: false,
      properties: { a: { type: "string", additionalProperties: true } },
    });
    expect("required" in out).toBe(false);
    expect("additionalProperties" in out).toBe(false);
    expect("additionalProperties" in (out.properties as any).a).toBe(false);
  });
});

describe("convertToolsToKiroFormat", () => {
  it("forces object root schema and placeholder description", () => {
    const out = convertToolsToKiroFormat([
      { name: "f", description: "", inputSchema: {} },
    ]);
    expect(out[0].toolSpecification.name).toBe("f");
    expect(out[0].toolSpecification.description).toBe("Tool: f");
    expect(out[0].toolSpecification.inputSchema.json.type).toBe("object");
    expect(out[0].toolSpecification.inputSchema.json.properties).toEqual({});
  });
});

describe("shortenToolName / buildToolNameReverseMap", () => {
  it("leaves short names unchanged", async () => {
    expect(await shortenToolName("short")).toBe("short");
  });
  it("shortens long names deterministically to 64 chars", async () => {
    const long = "a".repeat(80);
    const a1 = await shortenToolName(long);
    const a2 = await shortenToolName(long);
    expect(a1.length).toBe(TOOL_NAME_MAX_LENGTH);
    expect(a1).toBe(a2); // deterministic
  });
  it("builds an {alias: original} reverse map for shortened names only", async () => {
    const long = "b".repeat(80);
    const map = await buildToolNameReverseMap(["short", long]);
    expect(Object.values(map)).toContain(long);
    expect(Object.values(map)).not.toContain("short");
  });
});

describe("buildKiroPayload", () => {
  const baseArgs = {
    systemPrompt: "",
    modelId: "claude-sonnet-4.5",
    tools: null,
    conversationId: "conv-1",
    profileArn: "",
    thinkingConfig: { enabled: false, budgetTokens: null },
    config,
  };

  it("builds the conversationState envelope with current message", async () => {
    const messages: UnifiedMessage[] = [{ role: "user", content: "Hello" }];
    const { payload } = await buildKiroPayload({ ...baseArgs, messages });
    expect(payload.conversationState.chatTriggerType).toBe("MANUAL");
    expect(payload.conversationState.conversationId).toBe("conv-1");
    const uim = payload.conversationState.currentMessage.userInputMessage;
    // With default config, fake-reasoning/truncation system additions are
    // prepended to the (history-less) current message, so assert containment.
    expect(uim.content).toContain("Hello");
    expect(uim.modelId).toBe("claude-sonnet-4.5");
    expect(uim.origin).toBe("AI_EDITOR");
  });

  it("prepends the system prompt to the first history user message", async () => {
    const messages: UnifiedMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const { payload } = await buildKiroPayload({
      ...baseArgs,
      systemPrompt: "SYSTEM",
      messages,
    });
    const firstUser = payload.conversationState.history[0].userInputMessage;
    expect(firstUser.content).toContain("SYSTEM");
    expect(firstUser.content).toContain("first");
  });

  it("injects thinking tags when enabled", async () => {
    const messages: UnifiedMessage[] = [{ role: "user", content: "Q" }];
    const { payload } = await buildKiroPayload({
      ...baseArgs,
      thinkingConfig: { enabled: true, budgetTokens: 4000 },
      messages,
    });
    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(content).toContain("<max_thinking_length>4000</max_thinking_length>");
  });

  it("throws when there are no messages", async () => {
    await expect(buildKiroPayload({ ...baseArgs, messages: [] })).rejects.toThrow();
  });
});
