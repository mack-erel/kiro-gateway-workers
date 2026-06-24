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
 * Default cap on the inbound request body, enforced from Content-Length BEFORE
 * the body is read or parsed. Overridable via the KIRO_MAX_REQUEST_BYTES env var.
 *
 * Sized for this gateway's real traffic: agent clients (e.g. Claude Code) resend
 * the FULL conversation on every turn, and just before context compaction a
 * single legitimate request can reach tens of MB. The default must clear that
 * comfortably — it is a trip-wire against absurdly large (hundreds of MB)
 * requests, NOT a memory-safety device (Hono buffers + JSON.parse copies the
 * body, so true isolate protection isn't achievable with a byte cap anyway).
 * The assembled Kiro payload is separately bounded at ~600 KB
 * (KIRO_MAX_PAYLOAD_BYTES).
 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Resolve the body-size cap from env, falling back to the default. */
function maxBodyBytes(env: Env | undefined): number {
  const raw = env?.KIRO_MAX_REQUEST_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

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
    const limit = maxBodyBytes(c.env);
    if (Number.isFinite(bytes) && bytes > limit) {
      const message =
        `Request body of ${bytes} bytes exceeds the ${limit}-byte limit.`;
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
