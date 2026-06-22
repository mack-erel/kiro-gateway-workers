import { describe, it, expect } from "vitest";
import {
  normalizeModelName,
  getModelIdForKiro,
  extractModelFamily,
  ModelResolver,
} from "../src/lib/modelResolver";
import { ModelInfoCache } from "../src/lib/cache";

describe("normalizeModelName", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "claude-haiku-4.5"],
    ["claude-sonnet-4-5", "claude-sonnet-4.5"],
    ["claude-opus-4-5", "claude-opus-4.5"],
    ["claude-sonnet-4", "claude-sonnet-4"],
    ["claude-sonnet-4-20250514", "claude-sonnet-4"],
    ["claude-3-7-sonnet", "claude-3.7-sonnet"],
    ["claude-3-7-sonnet-20250219", "claude-3.7-sonnet"],
    ["claude-4.5-opus-high", "claude-opus-4.5"],
    ["claude-4.5-sonnet-low", "claude-sonnet-4.5"],
    ["auto", "auto"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeModelName(input)).toBe(expected);
  });

  it("strips a context-window suffix", () => {
    expect(normalizeModelName("claude-sonnet-4.5[1m]")).toBe("claude-sonnet-4.5");
  });

  it("leaves an already-normalized name unchanged", () => {
    expect(normalizeModelName("claude-3.7-sonnet")).toBe("claude-3.7-sonnet");
  });
});

describe("getModelIdForKiro", () => {
  it("resolves a hidden model to its internal id", () => {
    const hidden = { "claude-3.7-sonnet": "CLAUDE_3_7_SONNET_20250219_V1_0" };
    expect(getModelIdForKiro("claude-3-7-sonnet", hidden)).toBe(
      "CLAUDE_3_7_SONNET_20250219_V1_0",
    );
  });
  it("passes through a normalized name with no hidden mapping", () => {
    expect(getModelIdForKiro("claude-haiku-4-5", {})).toBe("claude-haiku-4.5");
  });
});

describe("extractModelFamily", () => {
  it.each([
    ["claude-haiku-4.5", "haiku"],
    ["claude-sonnet-4-5", "sonnet"],
    ["claude-3.7-sonnet", "sonnet"],
    ["gpt-4", null],
  ])("%s → %s", (input, expected) => {
    expect(extractModelFamily(input)).toBe(expected);
  });
});

describe("ModelResolver", () => {
  it("resolves aliases, then normalizes, then passes through", () => {
    const cache = new ModelInfoCache(3600_000);
    cache.update([{ modelId: "auto" }, { modelId: "claude-sonnet-4.5" }]);
    const resolver = new ModelResolver(cache, {}, { "auto-kiro": "auto" }, ["auto"]);

    expect(resolver.resolve("auto-kiro").internalId).toBe("auto");
    expect(resolver.resolve("auto-kiro").source).toBe("cache");

    const passthrough = resolver.resolve("some-unknown-model");
    expect(passthrough.source).toBe("passthrough");
    expect(passthrough.isVerified).toBe(false);
  });

  it("lists available models (cache ∪ aliases − hiddenFromList)", () => {
    const cache = new ModelInfoCache(3600_000);
    cache.update([{ modelId: "auto" }, { modelId: "claude-sonnet-4.5" }]);
    const resolver = new ModelResolver(cache, {}, { "auto-kiro": "auto" }, ["auto"]);
    const models = resolver.getAvailableModels();
    expect(models).toContain("claude-sonnet-4.5");
    expect(models).toContain("auto-kiro");
    expect(models).not.toContain("auto"); // hidden from list
  });
});
