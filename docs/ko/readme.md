# Kiro Gateway (Workers)

[English](../../README.md) · 🌐 **한국어**

**Kiro API**(Amazon Q Developer / AWS CodeWhisperer 백엔드)를 OpenAI / Anthropic
호환 형식으로 중계하는 프록시로, **Cloudflare Workers + Hono**(TypeScript) 위에서
동작합니다.

[kiro-gateway](https://github.com/jwadow/kiro-gateway)(Python/FastAPI)를
TypeScript로 포팅한 것이며, **API 키 passthrough 전용**으로 범위를 한정했습니다.

## "passthrough"의 의미

클라이언트가 **자신의** Kiro API 키(`ksk_…`)를 베어러 토큰으로 직접 제공합니다.
OpenAI 엔드포인트는 `Authorization: Bearer ksk_…`, Anthropic 엔드포인트는
`x-api-key: ksk_…` 헤더를 사용합니다. 게이트웨이는 이 키를 (`tokentype: API_KEY`
헤더를 덧붙여) 업스트림으로 그대로 전달하며, **서버 측에 자격 증명을 저장하지
않습니다**. 토큰 교환·갱신·다중 계정 페일오버·SQLite/JSON 자격 증명 로딩은
없습니다 — 원본 게이트웨이의 이런 모드들은 의도적으로 제외했습니다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/` | 생존 확인(liveness) |
| GET | `/health` | 상태 + 타임스탬프 + 버전 |
| GET | `/v1/models` | OpenAI 모델 목록 (`owned_by: "anthropic"`) |
| POST | `/v1/chat/completions` | OpenAI Chat Completions (스트리밍 + 비스트리밍) |
| POST | `/v1/messages` | Anthropic Messages (스트리밍 + 비스트리밍) |
| POST | `/v1/messages/count_tokens` | 로컬 토큰 추정 (업스트림 호출 없음) |
| POST | `/mcp` | MCP 서버 — `get_kiro_credits` 툴(잔여 크레딧 조회) |

모든 `/v1/*` 엔드포인트는 `ksk_…` 키가 필요합니다. 없으면 401을 반환합니다.

## 기능 (passthrough 경로 기준)

- OpenAI **와** Anthropic 동시 호환 — 둘 다 동시에 동작합니다.
- **가짜 추론(fake reasoning)** — `<thinking_mode>` 태그 주입 + FSM 추출로
  확장 사고(extended-thinking)를 에뮬레이션 → `reasoning_content`(OpenAI) /
  `thinking` 블록(Anthropic)으로 변환.
- **web_search** (MCP) — 네이티브(Path A)와 스트리밍 가로채기(Path B) 모두 지원.
- **툴 호출** — 64자 제한을 넘는 툴 이름을 결정론적으로 별칭(aliasing) 처리.
- **트렁케이션 복구(truncation recovery)** *(best-effort)* — Kiro의 스트림 중단을
  감지하고 다음 요청에 합성 복구 메시지를 주입. 상태가 isolate별 인메모리 맵에
  저장되므로, Workers에서는 후속 요청이 같은 isolate에 도달할 때만 동작합니다 —
  보장된 기능이 아니라 덤으로 여기세요. 자세한 내용은 `src/lib/truncation.ts`의
  주석 참고.
- **페이로드 가드** — Kiro의 ~615 KB 제한 하에서 선택적 트리밍.
- **첫 토큰 타임아웃** + 재시도 — 첫 바이트 전송 전 재요청.
- 토큰 카운팅 — `js-tiktoken`(cl100k_base) + Claude 보정 계수 1.15.

## 요구 사항

- Cloudflare Workers **Paid / Standard** 플랜. Free 플랜의 10ms CPU 제한은
  스트리밍 + 토큰화에 너무 낮습니다. `wrangler.jsonc`에서
  `limits.cpu_ms = 300000`으로 설정합니다.
- 로컬 개발/배포를 위한 Node.js 18+ 및 `wrangler`.

## 설정

```bash
npm install

# 로컬 개발
npm run dev

# 타입 체크 + 테스트
npm run typecheck
npm test

# 배포
npm run deploy
```

## 사용법

```bash
# OpenAI 스타일
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer ksk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Anthropic 스타일
curl http://localhost:8787/v1/messages \
  -H "x-api-key: ksk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4.5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

### MCP — 잔여 크레딧 조회

`POST /mcp`는 단일 읽기 전용 툴 `get_kiro_credits`를 노출하는 무상태(stateless)
MCP 서버(JSON-RPC 2.0)입니다. 호출자 본인의 `ksk_…` 키를 요청 헤더로 인증하며,
현재 청구 기간의 사용량/한도/잔여 크레딧, 구독 플랜, 다음 초기화일을 반환합니다.

```bash
# 직접 호출 (테스트/스크립트용)
curl https://kiro-api.static.mov/mcp \
  -H "Authorization: Bearer ksk_your_key" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_kiro_credits","arguments":{}}}'
```

MCP 클라이언트(Claude Code 등)에 등록:

```bash
claude mcp add --transport http --scope user kiro-credits \
  https://kiro-api.static.mov/mcp \
  --header "Authorization: Bearer ksk_your_key"
```

응답에는 사람이 읽는 텍스트 요약(`content`)과 기계용 구조화 JSON
(`structuredContent`: `plan`, `planType`, `nextResetDate`, `breakdown[]`)이 함께
담깁니다.

## 환경 설정

조정 가능한 값은 `wrangler.jsonc`의 `vars` 아래에 있으며, `loadConfig`
(`src/config.ts`)로 읽습니다:

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `KIRO_REGION` / `KIRO_API_REGION` | `us-east-1` | 업스트림 리전 |
| `FIRST_TOKEN_TIMEOUT` | `15` (초) | 재시도 전 첫 토큰 대기 시간 |
| `FIRST_TOKEN_MAX_RETRIES` | `3` | 스트림 재시도 횟수 |
| `STREAMING_READ_TIMEOUT` | `300` (초) | 청크 간 읽기 타임아웃 |
| `FAKE_REASONING_ENABLED` | `true` | thinking 태그 주입 |
| `FAKE_REASONING_HANDLING` | `as_reasoning_content` | thinking 출력 모드 |
| `TRUNCATION_RECOVERY` | `true` | 합성 복구 메시지 |
| `WEB_SEARCH_ENABLED` | `true` | web_search 툴 자동 주입 |
| `KIRO_MAX_PAYLOAD_BYTES` | `600000` | 페이로드 크기 가드 |
| `AUTO_TRIM_PAYLOAD` | `false` | 한도 초과 시 오래된 히스토리 트리밍 |
| `DEBUG_STREAM_EVENTS` | `false` | KiroEvent별 감사 로그 (Level 2) |
| `DEBUG_BODIES` | `false` | 요청/페이로드/응답 본문 감사 로그 (Level 3) |
| `PROXY_API_KEY` | _(미설정)_ | 선택적 비-ksk_ 게이트 (secret) |

## 감사 로깅 (audit logging)

모든 요청은 구조화된 한 줄 JSON 레코드를 `console`로 출력하며, Workers Logs /
`wrangler tail` / Logpush로 수집됩니다. 3단계 계층:

- **Level 1 — 항상 활성.** 요청 라이프사이클: `request.received`,
  `request.auth`(키는 **해시 처리**되며 원본은 절대 로깅하지 않음),
  `upstream.request`, `upstream.response`, `upstream.retry`,
  `request.completed`(토큰, 종료 사유, 경과 시간),
  `request.rejected` / `request.error`.
- **Level 2 — `DEBUG_STREAM_EVENTS=true`.** KiroEvent마다 `stream.event` 레코드
  하나(content/thinking/tool_use/usage/context_usage). 크기/메타데이터만 기록하며
  텍스트 자체는 기록하지 않음.
- **Level 3 — `DEBUG_BODIES=true`.** `request.body`, `kiro.payload`,
  `response.body`. **프롬프트 PII가 포함될 수 있어** 기본적으로 꺼져 있음.

각 레코드에는 `requestId`(상관관계 ID)와 ISO `ts`가 담깁니다. 실시간 확인:

```bash
npx wrangler tail
```

## 프로젝트 구조

```
src/
  index.ts            Hono 앱, CORS, /, /health, onError
  config.ts           상수 + loadConfig(env)
  types.ts            통합 요청 타입 + KiroEvent
  auth/               kiroAuth, passthroughSession, middleware
  routes/             openai, anthropic, mcp
  converters/         core (Kiro 페이로드), openai, anthropic
  streaming/          core (KiroEvent 파이프라인), openai, anthropic
  parsers/            eventStream (AWS 스크레이퍼), thinking (FSM)
  models/             openai, anthropic (zod 스키마)
  lib/                modelResolver, cache, tokenizer, mcpTools,
                      usageLimits, payloadGuards, truncation, errors,
                      httpClient, utils
test/                 vitest 단위 테스트
```

## 충실도(fidelity) 관련 참고

- Kiro 응답 스트림은 JSON 이벤트 접두사(`{"content":`, `{"name":`, …)를
  부분 문자열 스캔 + 중괄호 매처로 파싱합니다 — 바이너리 eventstream 코덱이
  아니며, 원본 `parsers.py`와 동일한 방식입니다.
- passthrough 경로의 `conversation_id`는 랜덤 UUID입니다(원본의 히스토리 해시
  방식은 여기서 사용하지 않음).
- 세션 모델 목록 캐시는 isolate별 best-effort입니다.

## 라이선스

업스트림 프로젝트를 따라 AGPL-3.0을 적용합니다.
