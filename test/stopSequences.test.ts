import { describe, it, expect } from "vitest";
import {
  normalizeStopSequences,
  StopSequenceMatcher,
  applyStopToText,
} from "../src/lib/stopSequences";

describe("normalizeStopSequences", () => {
  it("wraps a single string", () => {
    expect(normalizeStopSequences("STOP")).toEqual(["STOP"]);
  });
  it("passes an array through", () => {
    expect(normalizeStopSequences(["a", "b"])).toEqual(["a", "b"]);
  });
  it("drops empty strings and null/undefined", () => {
    expect(normalizeStopSequences(["", "x"])).toEqual(["x"]);
    expect(normalizeStopSequences(null)).toEqual([]);
    expect(normalizeStopSequences(undefined)).toEqual([]);
  });
});

describe("StopSequenceMatcher — single push", () => {
  it("truncates at the stop sequence and reports the match", () => {
    const m = new StopSequenceMatcher(["STOP"]);
    const r = m.push("hello STOP world");
    expect(r.emit).toBe("hello ");
    expect(r.stopped).toBe(true);
    expect(r.matched).toBe("STOP");
  });

  it("emits everything when no sequence is configured", () => {
    const m = new StopSequenceMatcher([]);
    const r = m.push("anything goes STOP through");
    expect(r.emit).toBe("anything goes STOP through");
    expect(r.stopped).toBe(false);
  });

  it("picks the earliest match across multiple sequences", () => {
    const m = new StopSequenceMatcher(["END", "STOP"]);
    const r = m.push("a STOP b END c");
    expect(r.emit).toBe("a ");
    expect(r.matched).toBe("STOP");
  });
});

describe("StopSequenceMatcher — cross-chunk safety", () => {
  it("holds back a partial-prefix tail until it resolves to a match", () => {
    const m = new StopSequenceMatcher(["STOP"]);
    // "ST" is a prefix of STOP → must be held back, not emitted.
    const r1 = m.push("hello ST");
    expect(r1.emit).toBe("hello ");
    expect(r1.stopped).toBe(false);

    const r2 = m.push("OP rest");
    expect(r2.emit).toBe("");
    expect(r2.stopped).toBe(true);
    expect(r2.matched).toBe("STOP");
  });

  it("releases a held-back tail that turns out NOT to be a stop sequence", () => {
    const m = new StopSequenceMatcher(["STOP"]);
    const r1 = m.push("hello ST");
    expect(r1.emit).toBe("hello ");

    const r2 = m.push("ELLAR"); // "STELLAR", not STOP
    expect(r2.emit).toBe("STELLAR");
    expect(r2.stopped).toBe(false);
  });

  it("handles a sequence split across three chunks", () => {
    const m = new StopSequenceMatcher(["<<END>>"]);
    expect(m.push("data<<").emit).toBe("data");
    expect(m.push("END").emit).toBe("");
    const r = m.push(">> trailing");
    expect(r.stopped).toBe(true);
    expect(r.matched).toBe("<<END>>");
  });

  it("flush releases the tail when the stream ends with no match", () => {
    const m = new StopSequenceMatcher(["STOP"]);
    m.push("ending in ST");
    expect(m.flush()).toBe("ST");
  });

  it("emits nothing further after a match, even on later pushes", () => {
    const m = new StopSequenceMatcher(["X"]);
    expect(m.push("aXb").emit).toBe("a");
    expect(m.push("more").emit).toBe("");
    expect(m.flush()).toBe("");
  });
});

describe("applyStopToText — one-shot", () => {
  it("truncates at the earliest match", () => {
    expect(applyStopToText("keep this STOP drop this", ["STOP"])).toEqual({
      text: "keep this ",
      stopped: true,
      matched: "STOP",
    });
  });
  it("returns the text unchanged when no match", () => {
    expect(applyStopToText("nothing here", ["STOP"])).toEqual({
      text: "nothing here",
      stopped: false,
      matched: null,
    });
  });
  it("picks the earliest of several matches", () => {
    const r = applyStopToText("a END b STOP c", ["STOP", "END"]);
    expect(r.text).toBe("a ");
    expect(r.matched).toBe("END");
  });
});
