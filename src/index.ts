/**
 * Kiro Gateway (Cloudflare Workers + Hono)
 *
 * OpenAI/Anthropic-compatible proxy for the Kiro API (AWS CodeWhisperer backend).
 * Authentication is API-key passthrough only: clients supply their own Kiro API
 * key (ksk_...) via `Authorization: Bearer` or `x-api-key`, and the gateway
 * forwards it directly upstream. No server-side credentials are stored.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./config";
import { openaiRoutes } from "./routes/openai";
import { anthropicRoutes } from "./routes/anthropic";
import { mcpRoutes } from "./routes/mcp";
import { classifyNetworkError, formatErrorForUser } from "./lib/errors";

const APP_VERSION = "0.1.0";

const app = new Hono<{ Bindings: Env }>();

// CORS: allow all origins (browser clients + preflight OPTIONS), mirroring the
// original gateway's permissive policy.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["*"],
    credentials: true,
  }),
);

// Liveness probe.
app.get("/", (c) =>
  c.json({
    name: "Kiro Gateway (Workers)",
    version: APP_VERSION,
    status: "ok",
  }),
);

// Health check with timestamp.
app.get("/health", (c) =>
  c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
  }),
);

// Route registration (OpenAI / Anthropic adapters + MCP server).
app.route("/", openaiRoutes);
app.route("/", anthropicRoutes);
app.route("/", mcpRoutes);

/** Decide whether a request path is an Anthropic endpoint (for error format). */
function isAnthropicPath(path: string): boolean {
  return path.startsWith("/v1/messages");
}

// Central error handler: HTTPException passes through; everything else is
// classified as a transport/network error and rendered in the right format.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  const info = classifyNetworkError(err);
  const format = isAnthropicPath(c.req.path) ? "anthropic" : "openai";
  return c.json(formatErrorForUser(info, format), info.suggestedHttpCode as any);
});

app.notFound((c) =>
  c.json({ error: { message: "Not found", type: "invalid_request_error" } }, 404),
);

export default app;
