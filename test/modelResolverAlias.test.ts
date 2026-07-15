import { describe, it, expect } from "vitest";
import {
  ModelResolver,
  getModelIdForKiro,
  normalizeModelName,
  stripDiscoveryPrefix,
} from "../src/lib/modelResolver";
import { ModelInfoCache } from "../src/lib/cache";
import { FALLBACK_MODELS, HIDDEN_MODELS, MODEL_ALIASES } from "../src/config";

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

describe("discovery prefix round-trip", () => {
  // The Anthropic /v1/models shape advertises non-Claude models as
  // `anthropic-<id>` to survive Claude Code's discovery filter. A client that
  // picks one sends the prefixed name back, so both spellings must land on the
  // same internal id — otherwise every model surfaced by discovery is unusable.
  it("strips the prefix a discovered model carries back", () => {
    expect(stripDiscoveryPrefix("anthropic-glm-5")).toBe("glm-5");
    expect(getModelIdForKiro("anthropic-glm-5", HIDDEN_MODELS)).toBe("glm-5");
    expect(getModelIdForKiro("anthropic-qwen3-coder-next", HIDDEN_MODELS)).toBe(
      "qwen3-coder-next",
    );
  });

  it("strips the prefix before the alias layer", () => {
    expect(getModelIdForKiro("anthropic-auto-kiro", HIDDEN_MODELS)).toBe("auto");
  });

  it("leaves unprefixed and claude- names alone", () => {
    expect(stripDiscoveryPrefix("glm-5")).toBe("glm-5");
    expect(getModelIdForKiro("glm-5", HIDDEN_MODELS)).toBe("glm-5");
    expect(getModelIdForKiro("claude-sonnet-4.5", HIDDEN_MODELS)).toBe(
      "claude-sonnet-4.5",
    );
  });

  it("resolves a prefixed id through ModelResolver, keeping the original request", () => {
    const cache = new ModelInfoCache(3600_000);
    cache.update(FALLBACK_MODELS);
    const resolver = new ModelResolver(cache, HIDDEN_MODELS, MODEL_ALIASES, []);

    const res = resolver.resolve("anthropic-glm-5");
    expect(res.internalId).toBe("glm-5");
    expect(res.source).toBe("cache");
    expect(res.isVerified).toBe(true);
    expect(res.originalRequest).toBe("anthropic-glm-5");
  });

  // The strip is unconditional in the bare helper, so a real model of that name
  // must win wherever a cache is available to prove it exists — otherwise a
  // future Kiro id like `anthropic-foo` would silently resolve to `foo`.
  it("prefers a real anthropic- model over un-prefixing it", () => {
    const cache = new ModelInfoCache(3600_000);
    cache.update([{ modelId: "anthropic-foo" }, { modelId: "foo" }]);
    const resolver = new ModelResolver(cache, HIDDEN_MODELS, MODEL_ALIASES, []);

    const res = resolver.resolve("anthropic-foo");
    expect(res.internalId).toBe("anthropic-foo");
    expect(res.source).toBe("cache");
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
