import { describe, it, expect } from "vitest";
import { estimateRequestTokens, CLAUDE_CORRECTION_FACTOR } from "../src/lib/tokenizer";

describe("estimateRequestTokens — single correction on the total", () => {
  it("applies the Claude correction once to the combined total, not per sub-total", () => {
    const messages = [{ role: "user", content: "hello world this is a test message" }];
    const tools = [
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ];
    const system = "system prompt text here";

    const est = estimateRequestTokens(messages, tools, system, true);
    const raw = estimateRequestTokens(messages, tools, system, false);

    // Total must equal floor(rawTotal * factor) — a single floor — and must be
    // >= the sum of the (separately-floored) corrected sub-totals, which is the
    // old compounding-undercount behavior.
    const expected = Math.floor(
      (raw.messagesTokens + raw.toolsTokens + raw.systemTokens) * CLAUDE_CORRECTION_FACTOR,
    );
    expect(est.totalTokens).toBe(expected);
    expect(est.totalTokens).toBeGreaterThanOrEqual(
      est.messagesTokens + est.toolsTokens + est.systemTokens,
    );
  });

  it("returns raw counts when correction is disabled", () => {
    const messages = [{ role: "user", content: "abc" }];
    const est = estimateRequestTokens(messages, null, null, false);
    expect(est.totalTokens).toBe(est.messagesTokens + est.toolsTokens + est.systemTokens);
  });
});
