import { describe, it, expect } from "vitest";
import { ModelInfoCache } from "../src/lib/cache";
import { calculateTokensFromContextUsage } from "../src/streaming/core";
import { DEFAULT_MAX_INPUT_TOKENS } from "../src/config";

/**
 * Token limits must be looked up by the *internal* Kiro model id, but the name
 * reaching this path is whatever the client sent — an alias (`auto-kiro`) or a
 * discovery-prefixed id (`anthropic-glm-5`), both of which the gateway itself
 * advertises via /v1/models. A raw cache lookup misses on those and silently
 * falls back to DEFAULT_MAX_INPUT_TOKENS, which then becomes the denominator
 * for usage.input_tokens — the number Claude Code drives auto-compaction off.
 */

/**
 * Shaped like Kiro's ListAvailableModels payload: keyed by internal modelId.
 * Every limit here is deliberately != DEFAULT_MAX_INPUT_TOKENS, so a test can
 * only pass by actually resolving the name — not by coincidentally matching
 * the fallback value.
 */
const MODELS = [
  { modelId: "glm-5", tokenLimits: { maxInputTokens: 128000 } },
  { modelId: "auto", tokenLimits: { maxInputTokens: 111000 } },
  { modelId: "claude-sonnet-4.5", tokenLimits: { maxInputTokens: 190000 } },
];

const cacheWithModels = (): ModelInfoCache => {
  const cache = new ModelInfoCache(3600_000);
  cache.update(MODELS);
  return cache;
};

describe("ModelInfoCache.getMaxInputTokens — advertised names resolve", () => {
  it("looks up an internal id directly", () => {
    expect(cacheWithModels().getMaxInputTokens("glm-5")).toBe(128000);
  });

  // /v1/models advertises non-Claude models discovery-prefixed, so a model
  // picked out of Claude Code's picker arrives here as `anthropic-glm-5`.
  it("resolves a discovery-prefixed id to the real model's limit", () => {
    expect(cacheWithModels().getMaxInputTokens("anthropic-glm-5")).toBe(128000);
  });

  // Pre-existing: `auto-kiro` is advertised (MODEL_ALIASES) but the cache is
  // keyed by `auto`, so the alias missed and silently took the default.
  it("resolves an alias to the real model's limit", () => {
    expect(cacheWithModels().getMaxInputTokens("auto-kiro")).toBe(111000);
    expect(cacheWithModels().getMaxInputTokens("anthropic-auto-kiro")).toBe(
      111000,
    );
  });

  it("normalizes dashed/dated names like the rest of the pipeline", () => {
    expect(cacheWithModels().getMaxInputTokens("claude-sonnet-4-5")).toBe(190000);
    expect(cacheWithModels().getMaxInputTokens("claude-sonnet-4.5")).toBe(190000);
  });

  // An exact cache hit must win over un-prefixing, or a real `anthropic-` model
  // would report a different model's limit.
  it("prefers an exact cache hit over stripping the prefix", () => {
    const cache = new ModelInfoCache(3600_000);
    cache.update([
      { modelId: "anthropic-foo", tokenLimits: { maxInputTokens: 64000 } },
      { modelId: "foo", tokenLimits: { maxInputTokens: 32000 } },
    ]);
    expect(cache.getMaxInputTokens("anthropic-foo")).toBe(64000);
    expect(cache.getMaxInputTokens("foo")).toBe(32000);
  });

  it("still defaults for a genuinely unknown model", () => {
    expect(cacheWithModels().getMaxInputTokens("not-a-real-model")).toBe(
      DEFAULT_MAX_INPUT_TOKENS,
    );
  });

  it("defaults on an empty cache rather than throwing", () => {
    expect(new ModelInfoCache(3600_000).getMaxInputTokens("glm-5")).toBe(
      DEFAULT_MAX_INPUT_TOKENS,
    );
  });
});

describe("usage accounting uses the picked model's real context window", () => {
  // The bug this guards: 50% of glm-5's 128k window is 64k, but a missed
  // lookup reports 50% of the 200k default = 100k — a 56% overcount that
  // mistimes Claude Code's auto-compaction.
  it("reports the same tokens for a prefixed id as for the raw id", () => {
    const cache = cacheWithModels();
    const raw = calculateTokensFromContextUsage(50, 1000, cache, "glm-5");
    const prefixed = calculateTokensFromContextUsage(
      50,
      1000,
      cache,
      "anthropic-glm-5",
    );
    expect(prefixed).toEqual(raw);
    // 50% of 128000 = 64000 total; prompt = total - completion.
    expect(prefixed[1]).toBe(64000);
    expect(prefixed[0]).toBe(63000);
  });
});
