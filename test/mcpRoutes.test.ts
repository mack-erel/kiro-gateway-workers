import { describe, it, expect } from "vitest";
import app from "../src/index";

/**
 * Route-level tests for the /mcp JSON-RPC endpoint, focused on the wiring of the
 * `list_kiro_models` tool: it is advertised via tools/list, and tools/call
 * guards on the caller's ksk_ key BEFORE any upstream discovery. Paths that
 * would reach the Kiro management endpoint are intentionally not exercised here.
 */
const ENV = {} as any;

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    ENV,
  );
  return { res, json: (await res.json()) as any };
}

describe("/mcp tools/list", () => {
  it("advertises both get_kiro_credits and list_kiro_models", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["get_kiro_credits", "list_kiro_models"]);

    const models = json.result.tools.find((t: any) => t.name === "list_kiro_models");
    expect(models.inputSchema.properties.format.enum).toEqual([
      "openai",
      "anthropic",
      "both",
    ]);
  });
});

describe("/mcp list_kiro_models auth guard", () => {
  it("returns an isError tool result when no ksk_ key is supplied", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_kiro_models", arguments: { format: "both" } },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/Kiro API key/i);
  });

  it("returns an isError tool result for a non-ksk_ bearer token", async () => {
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_kiro_models", arguments: {} },
      },
      { authorization: "Bearer not-a-ksk-key" },
    );
    expect(json.result.isError).toBe(true);
  });
});

describe("/mcp unknown tool", () => {
  it("returns a JSON-RPC error for an unknown tool name", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(json.error.code).toBe(-32602);
  });
});
