import { describe, it, expect } from "vitest";
import {
  saveToolTruncation,
  getToolTruncation,
  getCacheStats,
} from "../src/lib/truncation";

describe("truncation cache — bounded size", () => {
  it("round-trips tool truncation info and removes it on retrieval (one-time)", () => {
    saveToolTruncation("call_abc", "my_tool", { reason: "size" });
    const got = getToolTruncation("call_abc");
    expect(got?.toolName).toBe("my_tool");
    // One-time: a second read returns null.
    expect(getToolTruncation("call_abc")).toBeNull();
  });

  it("never grows beyond the size cap even under sustained saves", () => {
    // The follow-up request often lands on a different isolate, so entries are
    // frequently never retrieved. Inserting far more than the cap must not let
    // the cache grow unbounded.
    for (let i = 0; i < 1500; i++) {
      saveToolTruncation(`bulk_${i}`, "t", { i });
    }
    expect(getCacheStats().toolTruncations).toBeLessThanOrEqual(1000);
  });
});
