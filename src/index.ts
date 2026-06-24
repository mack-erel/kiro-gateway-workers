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

/**
 * Hard cap on the inbound request body, enforced from Content-Length BEFORE the
 * body is read or parsed. Workers allows up to 100 MB, but Hono buffers the
 * whole body in memory before `JSON.parse`, so an oversized request would
 * pressure the 128 MB isolate. 10 MB comfortably fits legitimate multimodal
 * requests (several base64 images) while rejecting abuse early — long before the
 * assembled Kiro payload hits its own ~600 KB limit (KIRO_MAX_PAYLOAD_BYTES).
 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const app = new Hono<{ Bindings: Env }>();

// CORS: allow all origins (browser clients + preflight OPTIONS). Auth is carried
// in explicit headers (Authorization / x-api-key), never in cookies, so there
// are no ambient credentials to protect — and `credentials: true` is deliberately
// omitted: browsers reject the `origin: "*"` + credentials combination outright,
// which would break browser-based clients.
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["*"],
  }),
);

// Reject oversized bodies up front, from Content-Length, before any handler
// reads or buffers the body. Errors are rendered in the format matching the
// target endpoint (Anthropic vs OpenAI).
app.use("*", async (c, next) => {
  const len = c.req.header("content-length");
  if (len !== undefined) {
    const bytes = Number(len);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      const message =
        `Request body of ${bytes} bytes exceeds the ${MAX_BODY_BYTES}-byte limit.`;
      return isAnthropicPath(c.req.path)
        ? c.json({ type: "error", error: { type: "invalid_request_error", message } }, 413)
        : c.json({ error: { message, type: "invalid_request_error" } }, 413);
    }
  }
  return next();
});

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
