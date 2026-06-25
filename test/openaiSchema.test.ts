import { describe, it, expect } from "vitest";
import { chatCompletionRequestSchema } from "../src/models/openai";

describe("chatCompletionRequestSchema — role + content validation", () => {
  it("rejects a message with no role", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "claude-sonnet-4.5",
      messages: [{ content: "hi" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid role", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "claude-sonnet-4.5",
      messages: [{ role: "wizard", content: "hi" }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts the documented roles incl. developer + tool", () => {
    for (const role of ["system", "user", "assistant", "tool", "developer"]) {
      const r = chatCompletionRequestSchema.safeParse({
        model: "m",
        messages: [{ role, content: "hi" }],
      });
      expect(r.success, role).toBe(true);
    }
  });

  it("rejects a content object (no longer swallowed by a bare z.any())", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "user", content: { weird: "object" } }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts null content (assistant with only tool_calls)", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "assistant", content: null, tool_calls: [] }],
    });
    expect(r.success).toBe(true);
  });
});

describe("chatCompletionRequestSchema — numeric bounds", () => {
  it("rejects out-of-range temperature", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects top_p above 1", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      top_p: 50,
    });
    expect(r.success).toBe(false);
  });

  it("rejects n below 1", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      n: -3,
    });
    expect(r.success).toBe(false);
  });

  it("accepts in-range generation params", () => {
    const r = chatCompletionRequestSchema.safeParse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 1.2,
      top_p: 0.9,
      presence_penalty: -1,
      frequency_penalty: 2,
      n: 1,
    });
    expect(r.success).toBe(true);
  });
});
