import { describe, it, expect } from "vitest";
import { trimPayloadToLimit, checkPayloadSize } from "../src/lib/payloadGuards";

/**
 * Regression tests for system-prompt preservation under auto-trim.
 *
 * The converter prepends the system prompt to the FIRST history user message;
 * trimming shifts oldest entries off the front, so without re-attachment the
 * system prompt is the first thing lost. trimPayloadToLimit(payload, max,
 * systemPrompt) must re-prepend it to the first surviving user message.
 */
const SYSTEM_PROMPT = "You are a helpful assistant. Follow all rules carefully.";

function makePayloadWithSystemPrompt(pairs: number, fillerLen: number) {
  const history: any[] = [];
  for (let i = 0; i < pairs; i++) {
    const content = i === 0 ? `${SYSTEM_PROMPT}\n\n${"u".repeat(fillerLen)}` : "u".repeat(fillerLen);
    history.push({ userInputMessage: { content, modelId: "m", origin: "AI_EDITOR" } });
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

/** Does any user message in history (or the current message) carry the prompt? */
function systemPromptPresent(payload: any): boolean {
  const history = payload.conversationState.history ?? [];
  for (const e of history) {
    if (e.userInputMessage?.content?.startsWith(SYSTEM_PROMPT)) return true;
  }
  const cur = payload.conversationState.currentMessage?.userInputMessage?.content ?? "";
  return cur.startsWith(SYSTEM_PROMPT);
}

describe("trimPayloadToLimit — system prompt preservation", () => {
  it("re-attaches the system prompt to the first surviving user message after trimming", () => {
    const payload = makePayloadWithSystemPrompt(10, 1000);
    expect(systemPromptPresent(payload)).toBe(true);

    const stats = trimPayloadToLimit(payload, 5000, SYSTEM_PROMPT);
    expect(stats.trimmed).toBe(true);
    // The original prompt-bearing entry was shifted off, but it must be back.
    expect(systemPromptPresent(payload)).toBe(true);
  });

  it("does not duplicate the prompt when it is already on the surviving message", () => {
    const payload = makePayloadWithSystemPrompt(10, 1000);
    trimPayloadToLimit(payload, 5000, SYSTEM_PROMPT);
    const withPrompt = payload.conversationState.history.filter((e: any) =>
      e.userInputMessage?.content?.includes(SYSTEM_PROMPT),
    );
    // Exactly one surviving user message should carry it (no double-prepend).
    expect(withPrompt.length).toBe(1);
  });

  it("falls back to the current message when history is fully trimmed", () => {
    const payload = makePayloadWithSystemPrompt(10, 5000);
    // Absurdly small limit forces history down to the 2-entry floor; but if the
    // surviving pair still doesn't carry it, the current message must.
    trimPayloadToLimit(payload, 50, SYSTEM_PROMPT);
    expect(systemPromptPresent(payload)).toBe(true);
  });

  it("leaves the payload untouched when no trimming occurs", () => {
    const payload = makePayloadWithSystemPrompt(1, 10);
    const before = checkPayloadSize(payload);
    const stats = trimPayloadToLimit(payload, 1_000_000, SYSTEM_PROMPT);
    expect(stats.trimmed).toBe(false);
    expect(checkPayloadSize(payload)).toBe(before);
  });
});
