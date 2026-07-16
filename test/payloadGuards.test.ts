import { describe, it, expect } from "vitest";
import { checkPayloadSize, trimPayloadToLimit } from "../src/lib/payloadGuards";

/** Build a payload with N user/assistant history pairs of given filler size. */
function makePayload(pairs: number, fillerLen: number) {
  const history: any[] = [];
  for (let i = 0; i < pairs; i++) {
    history.push({
      userInputMessage: { content: "u".repeat(fillerLen), modelId: "m", origin: "AI_EDITOR" },
    });
    history.push({ assistantResponseMessage: { content: "a".repeat(fillerLen) } });
  }
  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: "c",
      currentMessage: { userInputMessage: { content: "current", modelId: "m", origin: "AI_EDITOR" } },
      history,
    },
  };
}

describe("checkPayloadSize", () => {
  it("returns the UTF-8 byte length of compact JSON", () => {
    const size = checkPayloadSize({ a: "héllo" });
    // {"a":"héllo"} → é is 2 bytes
    expect(size).toBe(new TextEncoder().encode('{"a":"héllo"}').length);
  });
});

describe("trimPayloadToLimit", () => {
  it("trims oldest history pairs until under the limit", () => {
    const payload = makePayload(10, 1000); // ~20 KB+ of history
    const before = checkPayloadSize(payload);
    const stats = trimPayloadToLimit(payload, 5000);
    expect(stats.trimmed).toBe(true);
    expect(stats.finalBytes).toBeLessThan(before);
    expect(payload.conversationState.history.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps at least two history entries", () => {
    const payload = makePayload(10, 2000);
    trimPayloadToLimit(payload, 100); // absurdly small
    expect(payload.conversationState.history.length).toBeGreaterThanOrEqual(2);
  });

  it("does not trim when already under the limit", () => {
    const payload = makePayload(1, 10);
    const stats = trimPayloadToLimit(payload, 1_000_000);
    expect(stats.trimmed).toBe(false);
  });

  it("strips empty toolUses arrays", () => {
    const payload: any = makePayload(1, 10);
    payload.conversationState.history[1].assistantResponseMessage.toolUses = [];
    trimPayloadToLimit(payload, 1_000_000);
    expect(
      "toolUses" in payload.conversationState.history[1].assistantResponseMessage,
    ).toBe(false);
  });
});

describe("trimPayloadToLimit — oversized single message", () => {
  const LIMIT = 40_000;

  it("fits a current message that history trimming cannot reach", () => {
    const payload: any = makePayload(2, 100);
    payload.conversationState.currentMessage.userInputMessage.content =
      "x".repeat(500_000);

    const stats = trimPayloadToLimit(payload, LIMIT);

    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
    expect(stats.truncatedSlots).toBe(1);
    expect(stats.truncatedBytes).toBeGreaterThan(0);
  });

  it("keeps the head and tail of a truncated body", () => {
    const payload: any = makePayload(1, 10);
    payload.conversationState.currentMessage.userInputMessage.content =
      "HEAD_MARKER" + "x".repeat(500_000) + "TAIL_MARKER";

    trimPayloadToLimit(payload, LIMIT);

    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content.startsWith("HEAD_MARKER")).toBe(true);
    expect(content.endsWith("TAIL_MARKER")).toBe(true);
    expect(content).toContain("gateway truncated");
  });

  it("shortens an oversized tool result", () => {
    const payload: any = makePayload(1, 10);
    payload.conversationState.currentMessage.userInputMessage.userInputMessageContext = {
      toolResults: [
        { toolUseId: "t1", content: [{ text: "y".repeat(500_000) }] },
      ],
    };

    const stats = trimPayloadToLimit(payload, LIMIT);

    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
    expect(stats.truncatedSlots).toBe(1);
  });

  it("never splits a multi-byte character", () => {
    const payload: any = makePayload(1, 10);
    payload.conversationState.currentMessage.userInputMessage.content =
      "한글".repeat(100_000);

    trimPayloadToLimit(payload, LIMIT);

    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content).not.toContain("�");
  });

  it("preserves the system prompt verbatim while shortening the rest", () => {
    const systemPrompt = "SYSTEM: follow these rules exactly.";
    const payload: any = makePayload(1, 10);
    payload.conversationState.currentMessage.userInputMessage.content =
      systemPrompt + "\n\n" + "z".repeat(500_000);

    trimPayloadToLimit(payload, LIMIT, systemPrompt);

    const content = payload.conversationState.currentMessage.userInputMessage.content;
    expect(content.startsWith(systemPrompt)).toBe(true);
    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
  });

  it("fits content whose JSON escaping doubles its size", () => {
    // A pasted log: every quote and newline serializes to two bytes, so raw
    // UTF-8 length badly understates the payload cost.
    const payload: any = makePayload(1, 10);
    payload.conversationState.currentMessage.userInputMessage.content =
      '"\n'.repeat(250_000);

    trimPayloadToLimit(payload, LIMIT);

    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
  });

  it("reports failure rather than looping when the system prompt alone is too big", () => {
    const systemPrompt = "S".repeat(100_000);
    const payload: any = makePayload(1, 10);
    payload.conversationState.currentMessage.userInputMessage.content =
      systemPrompt + "z".repeat(100_000);

    const stats = trimPayloadToLimit(payload, LIMIT, systemPrompt);

    // Cannot fit without destroying the instructions — caller rejects instead.
    expect(checkPayloadSize(payload)).toBeGreaterThan(LIMIT);
    expect(stats.truncatedSlots).toBe(0);
  });

  it("leaves bodies alone when the payload already fits", () => {
    const payload: any = makePayload(1, 10);
    const before = payload.conversationState.currentMessage.userInputMessage.content;

    const stats = trimPayloadToLimit(payload, 1_000_000);

    expect(stats.truncatedSlots).toBe(0);
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe(before);
  });
});
