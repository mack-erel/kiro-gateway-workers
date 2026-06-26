# Kiro Gateway (Workers)

🌐 **English** · [한국어](docs/ko/readme.md)

OpenAI / Anthropic-compatible proxy for the **Kiro API** (Amazon Q Developer / AWS
CodeWhisperer backend), running on **Cloudflare Workers + Hono** (TypeScript).

This is a TypeScript port of [kiro-gateway](https://github.com/jwadow/kiro-gateway)
(Python/FastAPI), scoped to **API-key passthrough only**.

## What "passthrough" means

Clients supply **their own** Kiro API key (`ksk_…`) as the bearer token, via
`Authorization: Bearer ksk_…` (OpenAI endpoints) or `x-api-key: ksk_…`
(Anthropic endpoints). The gateway forwards that key directly upstream (adding a
`tokentype: API_KEY` header) and stores **no server-side credentials**. There is
no token exchange, refresh, multi-account failover, or SQLite/JSON credential
loading — those modes from the original gateway are intentionally omitted.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` | Liveness probe |
| GET | `/health` | Status + timestamp + version |
| GET | `/v1/models` | OpenAI model list (`owned_by: "anthropic"`) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |
| POST | `/v1/messages` | Anthropic Messages (stream + non-stream) |
| POST | `/v1/messages/count_tokens` | Local token estimate (no upstream call) |
| POST | `/mcp` | MCP server — `get_kiro_credits` tool (remaining credits) |

All `/v1/*` endpoints require a `ksk_…` key. Without one, the gateway returns 401.

## Features (parity with the passthrough path)

- OpenAI **and** Anthropic compatible, both live simultaneously.
- **Fake reasoning** (extended-thinking emulation) via `<thinking_mode>` tag
  injection + FSM extraction → `reasoning_content` (OpenAI) / `thinking` blocks
  (Anthropic).
- **web_search** (MCP) — native (Path A) and streaming-interception (Path B).
- **Tool calling**, including deterministic 64-char tool-name aliasing.
- **Truncation recovery** *(best-effort)* — detects Kiro mid-stream truncation
  and injects synthetic recovery messages on the next request. State is held in
  a per-isolate in-memory map, so on Workers it only fires when the follow-up
  request lands on the same isolate — treat it as a bonus, not a guarantee. See
  the note in `src/lib/truncation.ts`.
- **Payload guard** — optional trimming under Kiro's ~615 KB limit.
- **First-token timeout** with retry (re-fetch before the first byte is sent).
- Token counting via `js-tiktoken` (cl100k_base) with a 1.15 Claude correction.

## Requirements

- A Cloudflare Workers **Paid / Standard** plan. The Free plan's 10 ms CPU limit
  is too low for streaming + tokenization; `wrangler.jsonc` sets
  `limits.cpu_ms = 300000`.
- Node.js 18+ and `wrangler` for local dev / deploy.

## Setup

```bash
npm install

# Local dev
npm run dev

# Type check + tests
npm run typecheck
npm test

# Deploy
npm run deploy
```

## Usage

```bash
# OpenAI-style
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ksk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Anthropic-style
curl http://localhost:8787/v1/messages \
  -H "x-api-key: ksk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

### MCP — remaining credits

`POST /mcp` is a stateless MCP server (JSON-RPC 2.0) exposing a single read-only
tool, `get_kiro_credits`. It authenticates with the caller's own `ksk_…` key via
the request header and returns the current billing period's usage/limit/remaining
credits, subscription plan, and next reset date.

```bash
# Direct call (for testing / scripting)
curl https://kiro-api.static.mov/mcp \
  -H "Authorization: Bearer ksk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_kiro_credits","arguments":{}}}'
```

Register with an MCP client (e.g. Claude Code):

```bash
claude mcp add --transport http --scope user kiro-credits \
  https://kiro-api.static.mov/mcp \
  --header "Authorization: Bearer ksk_your_key"
```

The response carries both a human-readable text summary (`content`) and machine
structured JSON (`structuredContent`: `plan`, `planType`, `nextResetDate`,
`overageEnabled` / `overageStatus` / `overageCapability`, and `breakdown[]` —
each entry including `currentOverages`, `overageCap`, `overageRate`,
`overageCharges`, and `currency`). `overageEnabled` reflects whether the account
is allowed to spend beyond its plan allotment (`overageStatus === "ENABLED"`).

## Configuration

Tunables live in `wrangler.jsonc` under `vars` and are read via `loadConfig`
(`src/config.ts`):

| Var | Default | Purpose |
|-----|---------|---------|
| `KIRO_REGION` / `KIRO_API_REGION` | `us-east-1` | Upstream region |
| `FIRST_TOKEN_TIMEOUT` | `15` (s) | First-token wait before retry |
| `FIRST_TOKEN_MAX_RETRIES` | `3` | Stream retry attempts |
| `STREAMING_READ_TIMEOUT` | `300` (s) | Between-chunk read timeout |
| `FAKE_REASONING_ENABLED` | `true` | Thinking-tag injection |
| `FAKE_REASONING_HANDLING` | `as_reasoning_content` | Thinking output mode |
| `TRUNCATION_RECOVERY` | `true` | Synthetic recovery messages |
| `WEB_SEARCH_ENABLED` | `true` | Auto-inject web_search tool |
| `STREAM_DEDUP_CONSECUTIVE` | `true` | Drop consecutive identical content events in the stream parser |
| `KIRO_MAX_PAYLOAD_BYTES` | `600000` | Payload-size guard |
| `AUTO_TRIM_PAYLOAD` | `false` | Trim oldest history over the limit |
| `MODEL_CACHE_TTL` | `3600` (s) | Per-session model-list cache TTL (`0` disables) |
| `DEBUG_STREAM_EVENTS` | `false` | Audit-log each KiroEvent (Level 2) |
| `DEBUG_BODIES` | `false` | Audit-log request / payload / response bodies (Level 3) |
| `PROXY_API_KEY` | _(unset)_ | Optional non-ksk_ gate (secret) |

## Audit logging

Every request emits structured one-line JSON records to `console`, captured by
Workers Logs / `wrangler tail` / Logpush. Three tiers:

- **Level 1 — always on.** Request lifecycle: `request.received`,
  `request.auth` (key is **hashed**, never logged raw), `upstream.request`,
  `upstream.response`, `upstream.retry`, `request.completed` (tokens, stop
  reason, elapsed), `request.rejected` / `request.error`.
- **Level 2 — `DEBUG_STREAM_EVENTS=true`.** One `stream.event` record per
  KiroEvent (content/thinking/tool_use/usage/context_usage), with sizes/metadata
  only — not the text itself.
- **Level 3 — `DEBUG_BODIES=true`.** `request.body`, `kiro.payload`, and
  `response.body`. **May contain prompt PII**, so it is off by default.

Each record carries a `requestId` (correlation id) and an ISO `ts`. Watch live
with:

```bash
npx wrangler tail
```

## Project structure

```
src/
  index.ts            Hono app, CORS, /, /health, onError
  config.ts           constants + loadConfig(env)
  types.ts            unified request types + KiroEvent
  auth/               kiroAuth, passthroughSession, middleware
  routes/             openai, anthropic, mcp
  converters/         core (Kiro payload), openai, anthropic
  streaming/          core (KiroEvent pipeline), openai, anthropic
  parsers/            eventStream (AWS scraper), thinking (FSM)
  models/             openai, anthropic (zod schemas)
  lib/                modelResolver, cache, tokenizer, mcpTools,
                      usageLimits, payloadGuards, truncation, errors,
                      httpClient, utils
test/                 vitest unit tests
```

## Notes on fidelity

- The Kiro response stream is parsed by substring-scanning JSON event prefixes
  (`{"content":`, `{"name":`, …) with a brace matcher — not a binary
  eventstream codec — matching the original `parsers.py`.
- `conversation_id` in the passthrough path is a random UUID (the original
  history-hash variant is unused here).
- The session model-list cache is best-effort per isolate; KV is the
  cross-isolate cache.
- **Sampling parameters** (`temperature`, `top_p`, `top_k`, `presence_penalty`,
  …) are accepted but **silently ignored** — Kiro's `generateAssistantResponse`
  payload has no slot for them. They are not rejected, since that would break
  most clients. (`n > 1` and `logprobs`, by contrast, are rejected.)
- **`tool_choice`** is honored on a **best-effort** basis: Kiro has no native
  field for it, so `required`/`any`/a named tool / `none` are translated into a
  system-prompt instruction (same mechanism as `response_format`) rather than a
  hard upstream constraint.

## License

AGPL-3.0, following the upstream project.
