/**
 * Centralized configuration: constants, URL templates, and runtime settings.
 *
 * Static constants (model lists, tag definitions, URL templates) live as
 * module-level exports. Per-request tunables come from the Workers `Env`
 * (wrangler.jsonc `vars`) and are read via {@link loadConfig}.
 */

// ============================================================================
// Application metadata
// ============================================================================
export const APP_VERSION = "0.1.0";
export const APP_TITLE = "Kiro Gateway (Workers)";

// ============================================================================
// Kiro API URL templates
// ============================================================================
// Universal runtime endpoint for all regions (generateAssistantResponse, /mcp).
const KIRO_API_HOST_TEMPLATE = "https://runtime.{region}.kiro.dev";
// Q API host (ListAvailableModels fallback path).
const KIRO_Q_HOST_TEMPLATE = "https://runtime.{region}.kiro.dev";
// Management host: where API-key auth discovers the dynamic model list.
const KIRO_MANAGEMENT_HOST_TEMPLATE = "https://management.{region}.kiro.dev";

export const getKiroApiHost = (region: string): string =>
  KIRO_API_HOST_TEMPLATE.replace("{region}", region);
export const getKiroQHost = (region: string): string =>
  KIRO_Q_HOST_TEMPLATE.replace("{region}", region);
export const getKiroManagementHost = (region: string): string =>
  KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", region);

// ============================================================================
// Model resolution: aliases, hidden models, list-hiding, fallbacks
// ============================================================================

// Custom alias names → real Kiro model IDs. Exposed in /v1/models.
// Default alias avoids a conflict with Cursor IDE's built-in "auto" model.
export const MODEL_ALIASES: Record<string, string> = {
  "auto-kiro": "auto",
};

// Prefix under which non-Claude models are advertised in the Anthropic
// /v1/models shape. Claude Code's gateway model discovery drops every entry
// whose id does not start with "claude" or "anthropic", which would hide the
// entire non-Claude half of Kiro's catalog (glm-5, qwen3-coder-next, …) from
// the /model picker. The Anthropic list formatter adds this prefix and
// ModelResolver strips it back off, so `anthropic-glm-5` and `glm-5` are the
// same model. No Kiro model id starts with it, so the mapping is unambiguous.
export const DISCOVERY_PREFIX = "anthropic-";

// Models that work but are not advertised by Kiro's ListAvailableModels.
// Format: display name → internal Kiro ID.
export const HIDDEN_MODELS: Record<string, string> = {};

// Models hidden from the /v1/models listing (still usable when requested).
export const HIDDEN_FROM_LIST: string[] = ["auto"];

// Fallback model list used when ListAvailableModels is unreachable.
export const FALLBACK_MODELS: Array<{ modelId: string }> = [
  { modelId: "auto" },
  { modelId: "claude-sonnet-4" },
  { modelId: "claude-sonnet-4.5" },
  { modelId: "claude-sonnet-4.6" },
  { modelId: "claude-haiku-4.5" },
  { modelId: "claude-opus-4.5" },
  { modelId: "claude-opus-4.6" },
  { modelId: "claude-opus-4.7" },
  { modelId: "deepseek-3.2" },
  { modelId: "glm-5" },
  { modelId: "minimax-m2.1" },
  { modelId: "minimax-m2.5" },
  { modelId: "qwen3-coder-next" },
];

// ============================================================================
// Fake-reasoning (extended thinking emulation) tag detection
// ============================================================================
export const FAKE_REASONING_OPEN_TAGS = [
  "<thinking>",
  "<think>",
  "<reasoning>",
  "<thought>",
] as const;

export const DEFAULT_MAX_INPUT_TOKENS = 200000;

export type FakeReasoningHandling =
  | "as_reasoning_content"
  | "remove"
  | "pass"
  | "strip_tags";

/**
 * Workers environment bindings (wrangler.jsonc `vars` + KV namespace).
 * Regenerate the canonical type with `wrangler types`; this interface mirrors
 * the vars we read so config parsing stays type-safe.
 */
export interface Env {
  KIRO_REGION?: string;
  KIRO_API_REGION?: string;
  FIRST_TOKEN_TIMEOUT?: string;
  FIRST_TOKEN_MAX_RETRIES?: string;
  STREAMING_READ_TIMEOUT?: string;
  FAKE_REASONING_ENABLED?: string;
  FAKE_REASONING_HANDLING?: string;
  FAKE_REASONING_MAX_TOKENS?: string;
  FAKE_REASONING_BUDGET_CAP?: string;
  FAKE_REASONING_INITIAL_BUFFER_SIZE?: string;
  TRUNCATION_RECOVERY?: string;
  WEB_SEARCH_ENABLED?: string;
  /**
   * Drop consecutive-duplicate content events from the Kiro stream (default
   * true, matching the upstream parser). Set false to preserve legitimately
   * repeated tokens at the cost of forwarding Kiro's occasional double-emits.
   */
  STREAM_DEDUP_CONSECUTIVE?: string;
  /** Inbound HTTP body cap (bytes), enforced from Content-Length in index.ts. */
  KIRO_MAX_REQUEST_BYTES?: string;
  KIRO_MAX_PAYLOAD_BYTES?: string;
  KIRO_HARD_LIMIT_BYTES?: string;
  AUTO_TRIM_PAYLOAD?: string;
  TOOL_DESCRIPTION_MAX_LENGTH?: string;
  MODEL_CACHE_TTL?: string;
  LOG_LEVEL?: string;
  /** Audit log: emit one structured event per KiroEvent (off by default). */
  DEBUG_STREAM_EVENTS?: string;
  /** Audit log: emit request / Kiro-payload / response bodies (off by default). */
  DEBUG_BODIES?: string;
  /** Audit log: per-body char cap when DEBUG_BODIES is on (default 8192). */
  DEBUG_BODY_MAX_CHARS?: string;
  PROXY_API_KEY?: string;
}

/** Resolved, typed configuration derived from {@link Env}. */
export interface Config {
  apiRegion: string;
  firstTokenTimeoutMs: number;
  firstTokenMaxRetries: number;
  streamingReadTimeoutMs: number;
  fakeReasoningEnabled: boolean;
  fakeReasoningHandling: FakeReasoningHandling;
  fakeReasoningMaxTokens: number;
  fakeReasoningBudgetCap: number;
  fakeReasoningInitialBufferSize: number;
  truncationRecovery: boolean;
  webSearchEnabled: boolean;
  dedupConsecutiveContent: boolean;
  maxPayloadBytes: number;
  kiroHardLimitBytes: number;
  autoTrimPayload: boolean;
  toolDescriptionMaxLength: number;
  modelCacheTtlMs: number;
  logLevel: string;
  debugStreamEvents: boolean;
  debugBodies: boolean;
  debugBodyMaxChars: number;
  proxyApiKey: string | null;
}

const truthy = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === "") return dflt;
  return ["true", "1", "yes"].includes(v.toLowerCase());
};

const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * Like {@link num} but clamps to a minimum. Used for tunables where a
 * non-positive value would silently break the gateway (e.g. a zero payload cap
 * fails every request; a non-positive cache TTL makes the cache permanently
 * stale). Out-of-range values fall back to the default rather than the raw
 * input.
 */
const numMin = (v: string | undefined, dflt: number, min: number): number => {
  const n = num(v, dflt);
  return n >= min ? n : dflt;
};

const HANDLING_VALUES: FakeReasoningHandling[] = [
  "as_reasoning_content",
  "remove",
  "pass",
  "strip_tags",
];

/** Build the typed {@link Config} from raw Workers env vars. */
export function loadConfig(env: Env): Config {
  // API region precedence: explicit API region override > SSO region > default.
  const apiRegion = env.KIRO_API_REGION || env.KIRO_REGION || "us-east-1";

  const handlingRaw = (env.FAKE_REASONING_HANDLING || "").toLowerCase();
  const fakeReasoningHandling = HANDLING_VALUES.includes(
    handlingRaw as FakeReasoningHandling,
  )
    ? (handlingRaw as FakeReasoningHandling)
    : "as_reasoning_content";

  const firstTokenTimeoutMs = num(env.FIRST_TOKEN_TIMEOUT, 15) * 1000;
  const streamingReadTimeoutMs = num(env.STREAMING_READ_TIMEOUT, 300) * 1000;

  // Mirror Python's _warn_timeout_configuration: the first-token timeout must
  // be shorter than the inter-chunk read timeout, otherwise the read timeout
  // can never fire (the first-token race always wins first). Warn, don't throw.
  if (firstTokenTimeoutMs >= streamingReadTimeoutMs) {
    console.warn(
      JSON.stringify({
        event: "config.warning",
        message:
          "FIRST_TOKEN_TIMEOUT >= STREAMING_READ_TIMEOUT; the stream read " +
          "timeout will never trigger. Set FIRST_TOKEN_TIMEOUT below " +
          "STREAMING_READ_TIMEOUT.",
        firstTokenTimeoutMs,
        streamingReadTimeoutMs,
      }),
    );
  }

  return {
    apiRegion,
    // Python stores these in seconds; we keep milliseconds for setTimeout.
    firstTokenTimeoutMs,
    firstTokenMaxRetries: num(env.FIRST_TOKEN_MAX_RETRIES, 3),
    streamingReadTimeoutMs,
    fakeReasoningEnabled: truthy(env.FAKE_REASONING_ENABLED, true),
    fakeReasoningHandling,
    fakeReasoningMaxTokens: num(env.FAKE_REASONING_MAX_TOKENS, 4000),
    fakeReasoningBudgetCap: num(env.FAKE_REASONING_BUDGET_CAP, 10000),
    fakeReasoningInitialBufferSize: num(
      env.FAKE_REASONING_INITIAL_BUFFER_SIZE,
      20,
    ),
    truncationRecovery: truthy(env.TRUNCATION_RECOVERY, true),
    webSearchEnabled: truthy(env.WEB_SEARCH_ENABLED, true),
    dedupConsecutiveContent: truthy(env.STREAM_DEDUP_CONSECUTIVE, true),
    // Clamp to positive: a zero/negative payload cap would fail every request.
    maxPayloadBytes: numMin(env.KIRO_MAX_PAYLOAD_BYTES, 600000, 1),
    // Kiro rejects payloads over ~615KB with a misleading "Improperly formed
    // request." Payloads between maxPayloadBytes and this ceiling are forwarded
    // as-is (Kiro may still accept them); only above it do we shrink up front.
    kiroHardLimitBytes: numMin(env.KIRO_HARD_LIMIT_BYTES, 615000, 1),
    // Default on: when Kiro rejects an oversized payload, shrink history and
    // tool results and retry rather than failing the turn. Off keeps a strict
    // clean rejection with no trimming. Either way the current message is never
    // reshaped, and payloads within Kiro's ceiling are forwarded untouched.
    autoTrimPayload: truthy(env.AUTO_TRIM_PAYLOAD, true),
    toolDescriptionMaxLength: numMin(env.TOOL_DESCRIPTION_MAX_LENGTH, 10000, 1),
    // Clamp to non-negative: a negative TTL would make the cache permanently stale.
    modelCacheTtlMs: numMin(env.MODEL_CACHE_TTL, 3600, 0) * 1000,
    logLevel: (env.LOG_LEVEL || "INFO").toUpperCase(),
    debugStreamEvents: truthy(env.DEBUG_STREAM_EVENTS, false),
    debugBodies: truthy(env.DEBUG_BODIES, false),
    debugBodyMaxChars: num(env.DEBUG_BODY_MAX_CHARS, 8192),
    proxyApiKey: env.PROXY_API_KEY || null,
  };
}
