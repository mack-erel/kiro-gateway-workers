import { describe, it, expect } from "vitest";
import {
  checkPayloadSize,
  trimPayloadToLimit,
  PayloadTooLargeError,
  preflightPayloadAction,
  classifyKiroRejection,
} from "../src/lib/payloadGuards";

describe("PayloadTooLargeError", () => {
  const error = new PayloadTooLargeError(700_000, 600_000);

  it("matches the pattern Claude Code classifies API errors with", () => {
    // Verbatim from the CLI: a hit labels the turn "request too large —
    // /compact or trim". "exceeding" does not match; "too large" does.
    const classifier = /\b(too long|too large|exceeds|token limit|prompt is too long)\b/;
    expect(classifier.test(error.message)).toBe(true);
  });

  it("reports bytes, never claiming they are tokens", () => {
    expect(error.message).toContain("700000 bytes");
    expect(error.message).not.toMatch(/tokens?\b/);
  });

  it("names a recovery the caller can act on", () => {
    expect(error.message).toContain("/compact");
  });
});

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

/** Attach an oversized tool result to the current message. */
function withToolResult(payload: any, text: string) {
  payload.conversationState.currentMessage.userInputMessage.userInputMessageContext = {
    toolResults: [{ toolUseId: "t1", content: [{ text }] }],
  };
  return payload;
}

describe("trimPayloadToLimit — oversized single message", () => {
  const LIMIT = 40_000;

  it("fits a body that history trimming cannot reach", () => {
    const payload: any = withToolResult(makePayload(2, 100), "x".repeat(500_000));

    const stats = trimPayloadToLimit(payload, LIMIT);

    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
    expect(stats.truncatedSlots).toBe(1);
    expect(stats.truncatedBytes).toBeGreaterThan(0);
  });

  it("keeps the head and tail of a truncated body", () => {
    const payload: any = withToolResult(
      makePayload(1, 10),
      "HEAD_MARKER\n" + "x\n".repeat(250_000) + "TAIL_MARKER",
    );

    trimPayloadToLimit(payload, LIMIT);

    const text =
      payload.conversationState.currentMessage.userInputMessage
        .userInputMessageContext.toolResults[0].content[0].text;
    expect(text.startsWith("HEAD_MARKER")).toBe(true);
    expect(text.endsWith("TAIL_MARKER")).toBe(true);
    expect(text).toContain("gateway truncated");
  });

  it("cuts on line boundaries, leaving no partial line", () => {
    const line = "2026-07-02 09:26:14 [php7:notice] client 10.80.64.141 silent-exit\n";
    const payload: any = withToolResult(makePayload(1, 10), line.repeat(20_000));

    trimPayloadToLimit(payload, LIMIT);

    const text =
      payload.conversationState.currentMessage.userInputMessage
        .userInputMessageContext.toolResults[0].content[0].text;
    const [head, tail] = text.split("gateway truncated");
    // Every surviving line is whole: none is a fragment of the repeated line.
    for (const l of head.split("\n").filter(Boolean)) {
      if (l.startsWith("[...") || l.startsWith("...")) continue;
      expect(line.trimEnd()).toBe(l);
    }
    for (const l of tail.split("\n").filter(Boolean)) {
      if (l.endsWith("...]") || l.startsWith("...")) continue;
      expect(line.trimEnd()).toBe(l);
    }
  });

  it("falls back to a byte cut when there is no line boundary", () => {
    // One enormous line (minified JSON, font metrics): snapping to a newline
    // would throw away nearly everything, so the byte cut stands.
    const payload: any = withToolResult(makePayload(1, 10), "a".repeat(500_000));

    trimPayloadToLimit(payload, LIMIT);

    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
  });

  it("never shortens the current message's own content", () => {
    const payload: any = makePayload(1, 10);
    const paste = "붙여넣은 로그\n" + "라인\n".repeat(200_000);
    payload.conversationState.currentMessage.userInputMessage.content = paste;

    const stats = trimPayloadToLimit(payload, LIMIT);

    // Left verbatim: the caller can act on a clear rejection by sending less.
    expect(payload.conversationState.currentMessage.userInputMessage.content).toBe(paste);
    expect(stats.truncatedSlots).toBe(0);
    expect(checkPayloadSize(payload)).toBeGreaterThan(LIMIT);
  });

  it("never splits a multi-byte character", () => {
    const payload: any = withToolResult(makePayload(1, 10), "한글".repeat(100_000));

    trimPayloadToLimit(payload, LIMIT);

    const text =
      payload.conversationState.currentMessage.userInputMessage
        .userInputMessageContext.toolResults[0].content[0].text;
    expect(text).not.toContain("�");
  });

  it("preserves the system prompt verbatim while shortening the rest", () => {
    const systemPrompt = "SYSTEM: follow these rules exactly.";
    const payload: any = makePayload(1, 10);
    // The system prompt rides on the first history user message.
    payload.conversationState.history[0].userInputMessage.content =
      systemPrompt + "\n\n" + "z".repeat(500_000);

    trimPayloadToLimit(payload, LIMIT, systemPrompt);

    const content = payload.conversationState.history[0].userInputMessage.content;
    expect(content.startsWith(systemPrompt)).toBe(true);
    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
  });

  it("fits content whose JSON escaping doubles its size", () => {
    // A pasted log: every quote and newline serializes to two bytes, so raw
    // UTF-8 length badly understates the payload cost.
    const payload: any = withToolResult(makePayload(1, 10), '"\n'.repeat(250_000));

    trimPayloadToLimit(payload, LIMIT);

    expect(checkPayloadSize(payload)).toBeLessThanOrEqual(LIMIT);
  });

  it("reports failure rather than looping when the system prompt alone is too big", () => {
    const systemPrompt = "S".repeat(100_000);
    const payload: any = makePayload(1, 10);
    payload.conversationState.history[0].userInputMessage.content =
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

describe("preflightPayloadAction", () => {
  const policy = {
    maxPayloadBytes: 600_000,
    kiroHardLimitBytes: 615_000,
    autoTrimPayload: false,
  };

  it("forwards a payload under our cap", () => {
    expect(preflightPayloadAction(500_000, policy)).toBe("forward");
    expect(preflightPayloadAction(600_000, policy)).toBe("forward");
  });

  it("forwards untouched in the band between our cap and Kiro's ceiling", () => {
    // Kiro may still accept these; trimming here would lose detail needlessly.
    expect(preflightPayloadAction(605_000, policy)).toBe("forward");
    expect(preflightPayloadAction(615_000, policy)).toBe("forward");
  });

  it("rejects above Kiro's ceiling when auto-trim is off", () => {
    expect(preflightPayloadAction(620_000, policy)).toBe("reject");
  });

  it("trims above Kiro's ceiling when auto-trim is on", () => {
    expect(
      preflightPayloadAction(620_000, { ...policy, autoTrimPayload: true }),
    ).toBe("trim");
  });
});

describe("classifyKiroRejection", () => {
  const policy = { maxPayloadBytes: 600_000, autoTrimPayload: true };
  const sizeReject = { malformedRequest: true };
  const otherError = { malformedRequest: false };

  it("retries after trim on a size rejection when auto-trim is on", () => {
    expect(classifyKiroRejection(sizeReject, 610_000, false, policy)).toBe("retry-after-trim");
  });

  it("returns a clean too-large rejection when auto-trim is off", () => {
    expect(
      classifyKiroRejection(sizeReject, 610_000, false, { ...policy, autoTrimPayload: false }),
    ).toBe("reject-too-large");
  });

  it("passes through a non-size upstream error", () => {
    expect(classifyKiroRejection(otherError, 610_000, false, policy)).toBe("passthrough");
  });

  it("passes through when the payload is under our cap (never a size issue)", () => {
    // Our cap sits below Kiro's ceiling, so a sub-cap payload it rejects is
    // some other problem — trimming would not help.
    expect(classifyKiroRejection(sizeReject, 500_000, false, policy)).toBe("passthrough");
  });

  it("does not retry twice", () => {
    expect(classifyKiroRejection(sizeReject, 610_000, true, policy)).toBe("passthrough");
  });
});
