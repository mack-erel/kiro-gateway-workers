import { describe, it, expect } from "vitest";
import { enhanceKiroError, enhanceKiroErrorText } from "../src/lib/errors";

describe("enhanceKiroError — malformedRequest flag", () => {
  it("flags Kiro's size/shape rejection so the caller can shrink and retry", () => {
    // This is how an oversized payload comes back from Kiro.
    const info = enhanceKiroError({ message: "Improperly formed request.", reason: null });
    expect(info.malformedRequest).toBe(true);
  });

  it("does not flag other reasoned errors", () => {
    expect(
      enhanceKiroError({ message: "nope", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }).malformedRequest,
    ).toBe(false);
    expect(
      enhanceKiroError({ message: "nope", reason: "MONTHLY_REQUEST_COUNT" }).malformedRequest,
    ).toBe(false);
  });

  it("does not flag the same message when a real reason is attached", () => {
    // Only the null/unknown-reason variant is Kiro's generic size rejection.
    const info = enhanceKiroError({ message: "Improperly formed request.", reason: "SOMETHING" });
    expect(info.malformedRequest).toBe(false);
  });

  it("leaves malformedRequest false for unparseable error bodies", () => {
    expect(enhanceKiroErrorText("not json").malformedRequest).toBe(false);
  });
});
