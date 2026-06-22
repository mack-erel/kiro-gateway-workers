import { describe, it, expect } from "vitest";
import { ThinkingParser } from "../src/parsers/thinking";

/** Feed a full string through the parser and collect thinking/regular output. */
function run(input: string, mode: any = "as_reasoning_content") {
  const p = new ThinkingParser({ handlingMode: mode, initialBufferSize: 20 });
  let thinking = "";
  let regular = "";
  for (const ch of input) {
    const r = p.feed(ch);
    if (r.thinkingContent) thinking += r.thinkingContent;
    if (r.regularContent) regular += r.regularContent;
  }
  const fin = p.finalize();
  if (fin.thinkingContent) thinking += fin.thinkingContent;
  if (fin.regularContent) regular += fin.regularContent;
  return { thinking, regular, found: p.foundThinkingBlock };
}

describe("ThinkingParser", () => {
  it("splits a thinking block from following content", () => {
    const { thinking, regular, found } = run("<thinking>reasoning here</thinking>Final answer");
    expect(found).toBe(true);
    expect(thinking).toBe("reasoning here");
    expect(regular).toBe("Final answer");
  });

  it("treats plain content with no tag as regular content", () => {
    const { thinking, regular, found } = run("Just a normal response with no tags at all");
    expect(found).toBe(false);
    expect(thinking).toBe("");
    expect(regular).toBe("Just a normal response with no tags at all");
  });

  it("detects the tag even when split across feeds", () => {
    const p = new ThinkingParser({ handlingMode: "as_reasoning_content" });
    let thinking = "";
    let regular = "";
    for (const part of ["<thin", "king>abc", "</thinking>", "done"]) {
      const r = p.feed(part);
      if (r.thinkingContent) thinking += r.thinkingContent;
      if (r.regularContent) regular += r.regularContent;
    }
    const fin = p.finalize();
    if (fin.thinkingContent) thinking += fin.thinkingContent;
    if (fin.regularContent) regular += fin.regularContent;
    expect(thinking).toBe("abc");
    expect(regular).toBe("done");
  });

  it("supports <think> alias", () => {
    const { thinking, found } = run("<think>x</think>y");
    expect(found).toBe(true);
    expect(thinking).toBe("x");
  });

  it("flushes an unterminated thinking block on finalize", () => {
    const { thinking } = run("<thinking>unterminated reasoning text");
    expect(thinking).toContain("unterminated reasoning text");
  });
});
