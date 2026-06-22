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
import type { Env } from "./config";
import { openaiRoutes } from "./routes/openai";

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

// Route registration (OpenAI / Anthropic adapters).
app.route("/", openaiRoutes);

export default app;
