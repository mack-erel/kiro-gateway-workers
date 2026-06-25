import { describe, it, expect } from "vitest";
import { getModelIdForKiro, normalizeModelName } from "../src/lib/modelResolver";
import { HIDDEN_MODELS, MODEL_ALIASES } from "../src/config";

describe("getModelIdForKiro — alias resolution", () => {
  it("resolves the advertised auto-kiro alias to the real 'auto' model", () => {
    // /v1/models advertises 'auto-kiro' (MODEL_ALIASES); the converter path must
    // resolve it the same way ModelResolver.resolve does, or the advertised
    // model is unusable (the raw alias would reach Kiro, which rejects it).
    expect(getModelIdForKiro("auto-kiro", HIDDEN_MODELS)).toBe("auto");
  });

  it("passes through a normal model name unchanged", () => {
    expect(getModelIdForKiro("claude-sonnet-4.5", HIDDEN_MODELS)).toBe("claude-sonnet-4.5");
  });

  it("normalizes before hidden lookup (alias takes precedence over normalize)", () => {
    expect(getModelIdForKiro("auto-kiro", HIDDEN_MODELS, MODEL_ALIASES)).toBe("auto");
  });
});

describe("normalizeModelName — context-window suffix", () => {
  it("strips a [1m] suffix with surrounding whitespace", () => {
    expect(normalizeModelName("claude-sonnet-4-5 [1m]")).toBe("claude-sonnet-4.5");
  });

  it("strips a [200k] suffix with no whitespace", () => {
    expect(normalizeModelName("claude-opus-4-5[200k]")).toBe("claude-opus-4.5");
  });
});
