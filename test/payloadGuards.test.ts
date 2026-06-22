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
