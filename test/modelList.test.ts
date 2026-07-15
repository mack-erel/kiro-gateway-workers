import { describe, it, expect } from "vitest";
import {
  deriveDisplayName,
  toOpenAiModelList,
  toAnthropicModelList,
} from "../src/lib/modelList";

/**
 * Unit tests for the per-agent model-list formatters used by both the OpenAI
 * `/v1/models` route and the MCP `list_kiro_models` tool. Covers the two output
 * shapes (OpenAI vs Anthropic) and display-name derivation.
 */
const IDS = ["auto-kiro", "claude-sonnet-4.5", "qwen3-coder-next"];

describe("deriveDisplayName", () => {
  it("title-cases dash-separated model ids", () => {
    expect(deriveDisplayName("claude-sonnet-4.5")).toBe("Claude Sonnet 4.5");
    expect(deriveDisplayName("qwen3-coder-next")).toBe("Qwen3 Coder Next");
    expect(deriveDisplayName("glm-5")).toBe("Glm 5");
  });
});

describe("toOpenAiModelList", () => {
  it("renders the OpenAI /v1/models shape", () => {
    const list = toOpenAiModelList(IDS);
    expect(list.object).toBe("list");
    expect(list.data).toHaveLength(3);
    const first = list.data[0];
    expect(first).toMatchObject({
      id: "auto-kiro",
      object: "model",
      owned_by: "anthropic",
      description: "Claude model via Kiro API",
    });
    expect(typeof first.created).toBe("number");
  });

  it("handles an empty list", () => {
    const list = toOpenAiModelList([]);
    expect(list.object).toBe("list");
    expect(list.data).toEqual([]);
  });
});

describe("toAnthropicModelList", () => {
  it("renders the Anthropic /v1/models shape", () => {
    const list = toAnthropicModelList(IDS, { discoveryPrefix: true });
    expect(list.has_more).toBe(false);
    expect(list.first_id).toBe("anthropic-auto-kiro");
    expect(list.last_id).toBe("anthropic-qwen3-coder-next");
    expect(list.data).toHaveLength(3);
    expect(list.data[1]).toMatchObject({
      type: "model",
      id: "claude-sonnet-4.5",
      display_name: "Claude Sonnet 4.5",
    });
    // created_at is an ISO-8601 timestamp.
    expect(() => new Date(list.data[1].created_at).toISOString()).not.toThrow();
    expect(list.data[1].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("nulls the boundary ids for an empty list", () => {
    const list = toAnthropicModelList([]);
    expect(list.data).toEqual([]);
    expect(list.first_id).toBeNull();
    expect(list.last_id).toBeNull();
  });

  // Claude Code's gateway model discovery drops every entry whose id does not
  // start with claude/anthropic. Without the prefix the entire non-Claude half
  // of Kiro's catalog is invisible in the /model picker.
  it("prefixes non-Claude ids so gateway discovery keeps them", () => {
    const list = toAnthropicModelList(["glm-5", "qwen3-coder-next"], {
      discoveryPrefix: true,
    });
    expect(list.data.map((m) => m.id)).toEqual([
      "anthropic-glm-5",
      "anthropic-qwen3-coder-next",
    ]);
  });

  it("leaves already-discoverable ids untouched", () => {
    const list = toAnthropicModelList(["claude-opus-4.7"], {
      discoveryPrefix: true,
    });
    expect(list.data[0].id).toBe("claude-opus-4.7");
  });

  // Only the HTTP /v1/models response faces the discovery filter; the MCP tool
  // has no filter, and a prefix there would disagree with its own text summary.
  it("does not prefix unless discovery is explicitly requested", () => {
    expect(toAnthropicModelList(["glm-5"]).data[0].id).toBe("glm-5");
    expect(
      toAnthropicModelList(["glm-5"], { discoveryPrefix: false }).data[0].id,
    ).toBe("glm-5");
  });

  // The prefix is a wire detail: the picker must show "Glm 5", not
  // "Anthropic Glm 5".
  it("derives the display name from the unprefixed id", () => {
    const list = toAnthropicModelList(["glm-5"], { discoveryPrefix: true });
    expect(list.data[0].display_name).toBe("Glm 5");
  });

  // OpenAI clients have no discovery filter, so prefixing there would rename
  // every model out from under existing configs.
  it("does not prefix ids in the OpenAI shape", () => {
    const list = toOpenAiModelList(["glm-5"]);
    expect(list.data[0].id).toBe("glm-5");
  });
});
