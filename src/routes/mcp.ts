/**
 * Minimal MCP server (Streamable HTTP transport) exposing a single tool:
 * `get_kiro_credits` — reads the caller's remaining Kiro credits/usage limits.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST at `/mcp`, per the MCP Streamable HTTP
 * spec. This server is stateless (no SSE stream, no session id) — every call is
 * a self-contained request/response, which is all a single read-only tool needs.
 *
 * Auth: the client supplies its own Kiro ksk_ API key in the request header
 * (`Authorization: Bearer ksk_…` or `x-api-key: ksk_…`), exactly like the
 * gateway's other endpoints. No server-side credentials are stored.
 */
import { Hono } from "hono";
import type { Env } from "../config";
import { loadConfig } from "../config";
import {
  fetchUsageLimits,
  formatUsageSummary,
  type UsageLimits,
} from "../lib/usageLimits";
import {
  resolveAvailableModelIds,
  toOpenAiModelList,
  toAnthropicModelList,
} from "../lib/modelList";

export const mcpRoutes = new Hono<{ Bindings: Env }>();

/** Protocol version we implement; we echo the client's if we recognize it. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const SERVER_INFO = { name: "kiro-gateway-mcp", version: "0.1.0" };

const CREDITS_TOOL = {
  name: "get_kiro_credits",
  title: "Get Kiro Credits",
  description:
    "Get the caller's remaining Kiro credits and usage limits for the current " +
    "billing period. Returns used / limit / remaining credits, whether overage " +
    "(spending beyond the plan allotment) is enabled, the subscription plan, and " +
    "the next reset date. Authenticated with the caller's own Kiro API key " +
    "supplied in the request Authorization header.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      plan: { type: ["string", "null"], description: "Subscription plan title." },
      planType: { type: ["string", "null"] },
      nextResetDate: {
        type: ["string", "null"],
        description: "ISO-8601 date when usage resets.",
      },
      overageEnabled: {
        type: ["boolean", "null"],
        description:
          "Whether spending beyond the plan allotment is allowed (overageStatus === ENABLED).",
      },
      overageStatus: {
        type: ["string", "null"],
        description: "Raw overage status, e.g. \"ENABLED\" / \"DISABLED\".",
      },
      overageCapability: {
        type: ["string", "null"],
        description: "Account overage capability, e.g. \"OVERAGE_CAPABLE\".",
      },
      breakdown: {
        type: "array",
        items: {
          type: "object",
          properties: {
            resourceName: { type: "string" },
            resourceType: { type: ["string", "null"] },
            used: { type: "number" },
            limit: { type: "number" },
            remaining: { type: "number" },
            usedFraction: { type: ["number", "null"] },
            unit: { type: ["string", "null"] },
            currentOverages: {
              type: "number",
              description: "Overage consumed beyond the allotment this period.",
            },
            overageCap: {
              type: ["number", "null"],
              description: "Max overage permitted beyond the allotment.",
            },
            overageRate: {
              type: ["number", "null"],
              description: "Per-unit overage price.",
            },
            overageCharges: {
              type: "number",
              description: "Money charged for overage so far this period.",
            },
            currency: {
              type: ["string", "null"],
              description: "ISO-4217 currency for overage charges/rate.",
            },
          },
        },
      },
    },
  },
} as const;

const MODEL_FORMATS = ["openai", "anthropic", "both"] as const;
type ModelFormat = (typeof MODEL_FORMATS)[number];

const MODELS_TOOL = {
  name: "list_kiro_models",
  title: "List Kiro Models",
  description:
    "List the models available to the caller, discovered live from the Kiro " +
    "management endpoint, rendered in each agent's native shape. The `format` " +
    "argument selects the output: \"openai\" (OpenAI /v1/models shape), " +
    "\"anthropic\" (Anthropic /v1/models shape), or \"both\" (default). " +
    "Authenticated with the caller's own Kiro API key supplied in the request " +
    "Authorization header.",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: MODEL_FORMATS,
        description:
          "Output shape: \"openai\", \"anthropic\", or \"both\" (default).",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      openai: {
        type: ["object", "null"],
        description: "OpenAI /v1/models list (present when format is openai/both).",
      },
      anthropic: {
        type: ["object", "null"],
        description: "Anthropic /v1/models list (present when format is anthropic/both).",
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

const rpcResult = (id: string | number | null | undefined, result: any) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result,
});

const rpcError = (
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: any,
) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

/** Extract a ksk_ key from Authorization: Bearer or x-api-key. */
function extractApiKey(authHeader?: string, xApiKey?: string): string | null {
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  if (xApiKey) return xApiKey;
  return null;
}

/** Build the structured tool payload (sans `raw`) for structuredContent. */
function toStructured(u: UsageLimits) {
  return {
    plan: u.plan,
    planType: u.planType,
    nextResetDate: u.nextResetDate,
    overageEnabled: u.overageEnabled,
    overageStatus: u.overageStatus,
    overageCapability: u.overageCapability,
    breakdown: u.breakdown,
  };
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleInitialize(req: JsonRpcRequest) {
  const requested = req.params?.protocolVersion as string | undefined;
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
  return rpcResult(req.id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  });
}

function handleToolsList(req: JsonRpcRequest) {
  return rpcResult(req.id, { tools: [CREDITS_TOOL, MODELS_TOOL] });
}

/** Missing/invalid ksk_ key, surfaced as a tool error (isError) for the model. */
function missingKeyResult(req: JsonRpcRequest) {
  return rpcResult(req.id, {
    content: [
      {
        type: "text",
        text:
          "Missing or invalid Kiro API key. Supply your ksk_ key via the " +
          "Authorization: Bearer header (or x-api-key).",
      },
    ],
    isError: true,
  });
}

/** Build a compact human-readable summary of the model IDs. */
function formatModelSummary(ids: string[]): string {
  if (ids.length === 0) return "No models available.";
  const lines = ids.map((id) => `- ${id}`).join("\n");
  return `${ids.length} model(s) available:\n${lines}`;
}

async function handleListModels(req: JsonRpcRequest, env: Env, apiKey: string | null) {
  if (!apiKey || !apiKey.startsWith("ksk_")) {
    return missingKeyResult(req);
  }

  const requested = req.params?.arguments?.format as string | undefined;
  const format: ModelFormat = MODEL_FORMATS.includes(requested as ModelFormat)
    ? (requested as ModelFormat)
    : "both";

  const config = loadConfig(env);
  try {
    const ids = await resolveAvailableModelIds(apiKey, config);
    const structured: Record<string, unknown> = {};
    if (format === "openai" || format === "both") {
      structured.openai = toOpenAiModelList(ids);
    }
    if (format === "anthropic" || format === "both") {
      structured.anthropic = toAnthropicModelList(ids);
    }
    return rpcResult(req.id, {
      content: [{ type: "text", text: formatModelSummary(ids) }],
      structuredContent: structured,
    });
  } catch (e) {
    return rpcResult(req.id, {
      content: [
        {
          type: "text",
          text: `Failed to list Kiro models: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
      isError: true,
    });
  }
}

async function handleToolsCall(req: JsonRpcRequest, env: Env, apiKey: string | null) {
  const name = req.params?.name as string | undefined;
  if (name === MODELS_TOOL.name) {
    return handleListModels(req, env, apiKey);
  }
  if (name !== CREDITS_TOOL.name) {
    return rpcError(req.id, -32602, `Unknown tool: ${name ?? "(none)"}`);
  }
  if (!apiKey || !apiKey.startsWith("ksk_")) {
    // Surface auth failure as a tool error (isError) so MCP clients show it to
    // the model/user, rather than a transport-level RPC error.
    return missingKeyResult(req);
  }

  const region = env.KIRO_API_REGION || env.KIRO_REGION || "us-east-1";
  try {
    const usage = await fetchUsageLimits(apiKey, region);
    return rpcResult(req.id, {
      content: [{ type: "text", text: formatUsageSummary(usage) }],
      structuredContent: toStructured(usage),
    });
  } catch (e) {
    return rpcResult(req.id, {
      content: [
        {
          type: "text",
          text: `Failed to fetch Kiro usage limits: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
      isError: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

mcpRoutes.post("/mcp", async (c) => {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "Parse error: invalid JSON"), 400);
  }

  const apiKey = extractApiKey(c.req.header("Authorization"), c.req.header("x-api-key"));

  const dispatch = async (req: JsonRpcRequest) => {
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return rpcError(req?.id, -32600, "Invalid Request");
    }
    // Notifications (no id) get no response body.
    const isNotification = req.id === undefined || req.id === null;
    switch (req.method) {
      case "initialize":
        return handleInitialize(req);
      case "tools/list":
        return handleToolsList(req);
      case "tools/call":
        return handleToolsCall(req, c.env, apiKey);
      case "ping":
        return rpcResult(req.id, {});
      default:
        if (isNotification) return null; // e.g. notifications/initialized
        return rpcError(req.id, -32601, `Method not found: ${req.method}`);
    }
  };

  // Batch support.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(dispatch))).filter((r) => r !== null);
    return responses.length ? c.json(responses) : c.body(null, 202);
  }

  const response = await dispatch(body);
  return response === null ? c.body(null, 202) : c.json(response);
});

// MCP clients may probe with GET (for an SSE stream). We are POST-only.
mcpRoutes.get("/mcp", (c) =>
  c.json(rpcError(null, -32000, "This MCP server is stateless; use POST /mcp."), 405),
);
