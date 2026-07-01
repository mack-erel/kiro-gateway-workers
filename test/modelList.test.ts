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
    const list = toAnthropicModelList(IDS);
    expect(list.has_more).toBe(false);
    expect(list.first_id).toBe("auto-kiro");
    expect(list.last_id).toBe("qwen3-coder-next");
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
});
