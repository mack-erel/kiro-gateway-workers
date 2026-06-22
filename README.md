# Kiro Gateway (Workers)

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

All `/v1/*` endpoints require a `ksk_…` key. Without one, the gateway returns 401.

## Features (parity with the passthrough path)

- OpenAI **and** Anthropic compatible, both live simultaneously.
- **Fake reasoning** (extended-thinking emulation) via `<thinking_mode>` tag
  injection + FSM extraction → `reasoning_content` (OpenAI) / `thinking` blocks
  (Anthropic).
- **web_search** (MCP) — native (Path A) and streaming-interception (Path B).
- **Tool calling**, including deterministic 64-char tool-name aliasing.
- **Truncation recovery** — detects Kiro mid-stream truncation and injects
  synthetic recovery messages on the next request.
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

# Create the KV namespace used to cache per-key model lists, then put the
# returned id into wrangler.jsonc (kv_namespaces[0].id / preview_id).
npx wrangler kv namespace create MODELS_KV

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
| `KIRO_MAX_PAYLOAD_BYTES` | `600000` | Payload-size guard |
| `AUTO_TRIM_PAYLOAD` | `false` | Trim oldest history over the limit |
| `PROXY_API_KEY` | _(unset)_ | Optional non-ksk_ gate (secret) |

## Project structure

```
src/
  index.ts            Hono app, CORS, /, /health, onError
  config.ts           constants + loadConfig(env)
  types.ts            unified request types + KiroEvent
  auth/               kiroAuth, passthroughSession, middleware
  routes/             openai, anthropic
  converters/         core (Kiro payload), openai, anthropic
  streaming/          core (KiroEvent pipeline), openai, anthropic
  parsers/            eventStream (AWS scraper), thinking (FSM)
  models/             openai, anthropic (zod schemas)
  lib/                modelResolver, cache, tokenizer, mcpTools,
                      payloadGuards, truncation, errors, httpClient, utils
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

## License

AGPL-3.0, following the upstream project.
