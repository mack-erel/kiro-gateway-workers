/**
 * Dynamic model resolution. Faithful port of `kiro/model_resolver.py`.
 *
 * 5-layer pipeline: discovery-prefix strip → alias → normalize (dashes→dots,
 * strip dates) → dynamic cache → hidden models → pass-through. Principle:
 * gateway, not gatekeeper — resolve() never throws; unknown models pass through
 * for Kiro to judge.
 */
import { DISCOVERY_PREFIX, FALLBACK_MODELS, MODEL_ALIASES } from "../config";
import type { ModelInfoCache } from "./cache";

/** Valid runtime model IDs (from FALLBACK_MODELS, single source of truth). */
export const VALID_RUNTIME_MODEL_IDS = new Set(
  FALLBACK_MODELS.map((m) => m.modelId),
);

/** Pass-through (no fallback) — gateway, not gatekeeper. */
function toRuntimeModelId(normalized: string): string {
  return normalized;
}

export interface ModelResolution {
  internalId: string;
  source: "cache" | "hidden" | "passthrough";
  originalRequest: string;
  normalized: string;
  isVerified: boolean;
}

/**
 * Normalize a client model name to Kiro format. Applies the same five regex
 * patterns as the Python original (standard, no-minor, legacy, dot+date,
 * inverted+suffix), after stripping a `[1m]`/`[200k]` context-window suffix.
 */
export function normalizeModelName(name: string): string {
  if (!name) return name;

  // Strip a trailing context-window suffix (e.g. [1m], [200k]) and any
  // whitespace before it — clients sometimes send "claude-opus-4 [1m]".
  name = name.replace(/\s*\[\d+[mk]\]\s*$/i, "").trim();

  const lower = name.toLowerCase();

  // Pattern 1: claude-{family}-{major}-{minor}(-{suffix})?
  // Minor is 1-2 digits (8-digit dates must NOT match here).
  let m = lower.match(
    /^(claude-(?:haiku|sonnet|opus)-\d+)-(\d{1,2})(?:-(?:\d{8}|latest|\d+))?$/,
  );
  if (m) return `${m[1]}.${m[2]}`;

  // Pattern 2: claude-{family}-{major}(-{date})?
  m = lower.match(/^(claude-(?:haiku|sonnet|opus)-\d+)(?:-\d{8})?$/);
  if (m) return m[1];

  // Pattern 3: legacy claude-{major}-{minor}-{family}(-{suffix})?
  m = lower.match(
    /^(claude)-(\d+)-(\d+)-(haiku|sonnet|opus)(?:-(?:\d{8}|latest|\d+))?$/,
  );
  if (m) return `${m[1]}-${m[2]}.${m[3]}-${m[4]}`;

  // Pattern 4: already dotted but with a date suffix.
  m = lower.match(
    /^(claude-(?:\d+\.\d+-)?(?:haiku|sonnet|opus)(?:-\d+\.\d+)?)-\d{8}$/,
  );
  if (m) return m[1];

  // Pattern 5: inverted format WITH suffix — claude-{major}.{minor}-{family}-{suffix}.
  // Requires a suffix to avoid matching already-normalized claude-3.7-sonnet.
  m = lower.match(/^claude-(\d+)\.(\d+)-(haiku|sonnet|opus)-(.+)$/);
  if (m) return `claude-${m[3]}-${m[1]}.${m[2]}`;

  // No transformation — return as-is (preserves original case for passthrough).
  return name;
}

/**
 * Lightweight helper for converters: alias → normalize → hidden-model lookup,
 * returning the model ID to send to Kiro. Mirrors `get_model_id_for_kiro` and
 * the same alias→normalize→hidden ordering as {@link ModelResolver.resolve}.
 *
 * Applying MODEL_ALIASES here is essential: /v1/models advertises alias names
 * (e.g. `auto-kiro`) via ModelResolver, so a client may legitimately request
 * one. Without alias resolution the raw alias would be forwarded to Kiro, which
 * does not recognize it — the advertised model would be unusable.
 */
export function getModelIdForKiro(
  modelName: string,
  hiddenModels: Record<string, string>,
  aliases: Record<string, string> = MODEL_ALIASES,
): string {
  const unprefixed = stripDiscoveryPrefix(modelName);
  const aliased = aliases[unprefixed] ?? unprefixed;
  const normalized = normalizeModelName(aliased);
  const internal = hiddenModels[normalized] ?? normalized;
  return toRuntimeModelId(internal);
}

/**
 * Strip the {@link DISCOVERY_PREFIX} the Anthropic `/v1/models` shape adds to
 * non-Claude ids. Clients that picked a model out of that list send it back
 * prefixed (`anthropic-glm-5`), so the prefix must come off before the alias
 * layer or the raw string would reach Kiro, which does not know it.
 *
 * Case-insensitive, matching {@link normalizeModelName} and the list
 * formatter's discoverability check — the three must agree on what the prefix
 * is or a name can be advertised prefixed and arrive unstripped.
 *
 * Unconditional, which is safe only while no real Kiro id starts with
 * `anthropic-`. That holds for FALLBACK_MODELS and for every id Kiro's
 * ListAvailableModels returns today (Bedrock-style names use a dot —
 * `anthropic.claude-v2` — and so do not match), but the live list is a
 * third-party input: if Kiro ever ships an `anthropic-` id, it would resolve to
 * the stripped name instead of itself. Callers holding a model cache should
 * prefer a real match over un-prefixing.
 */
export function stripDiscoveryPrefix(name: string): string {
  return name.toLowerCase().startsWith(DISCOVERY_PREFIX)
    ? name.slice(DISCOVERY_PREFIX.length)
    : name;
}

/** Extract Claude family ('haiku'|'sonnet'|'opus') or null. */
export function extractModelFamily(modelName: string): string | null {
  const m = modelName.match(/(haiku|sonnet|opus)/i);
  return m ? m[1].toLowerCase() : null;
}

export class ModelResolver {
  private readonly cache: ModelInfoCache;
  private readonly hiddenModels: Record<string, string>;
  private readonly aliases: Record<string, string>;
  private readonly hiddenFromList: Set<string>;

  constructor(
    cache: ModelInfoCache,
    hiddenModels: Record<string, string> = {},
    aliases: Record<string, string> = {},
    hiddenFromList: string[] = [],
  ) {
    this.cache = cache;
    this.hiddenModels = hiddenModels;
    this.aliases = aliases;
    this.hiddenFromList = new Set(hiddenFromList);
  }

  /** Resolve an external model name to an internal Kiro ID (never throws). */
  resolve(externalModel: string): ModelResolution {
    // Layer 0a: discovery prefix (added by the Anthropic /v1/models shape).
    // A real model of that exact name wins over un-prefixing, so a future Kiro
    // id starting with `anthropic-` resolves to itself rather than to whatever
    // stripping the prefix happens to spell.
    const unprefixed = this.cache.isValidModel(externalModel)
      ? externalModel
      : stripDiscoveryPrefix(externalModel);

    // Layer 0b: alias.
    const resolvedModel = this.aliases[unprefixed] ?? unprefixed;

    // Layer 1: normalize.
    const normalized = normalizeModelName(resolvedModel);

    // Layer 2: dynamic cache.
    if (this.cache.isValidModel(normalized)) {
      return {
        internalId: toRuntimeModelId(normalized),
        source: "cache",
        originalRequest: externalModel,
        normalized,
        isVerified: true,
      };
    }

    // Layer 3: hidden models.
    if (normalized in this.hiddenModels) {
      return {
        internalId: toRuntimeModelId(this.hiddenModels[normalized]),
        source: "hidden",
        originalRequest: externalModel,
        normalized,
        isVerified: true,
      };
    }

    // Layer 4: pass-through.
    return {
      internalId: toRuntimeModelId(normalized),
      source: "passthrough",
      originalRequest: externalModel,
      normalized,
      isVerified: false,
    };
  }

  /** All model IDs for /v1/models (cache ∪ hidden ∪ aliases − hiddenFromList). */
  getAvailableModels(): string[] {
    const models = new Set(this.cache.getAllModelIds());
    for (const k of Object.keys(this.hiddenModels)) models.add(k);
    for (const h of this.hiddenFromList) models.delete(h);
    for (const a of Object.keys(this.aliases)) models.add(a);
    return Array.from(models).sort();
  }

  getModelsByFamily(family: string): string[] {
    const all = this.getAvailableModels();
    return all.filter((m) => m.toLowerCase().includes(family.toLowerCase()));
  }

  getSuggestionsForModel(modelName: string): string[] {
    const family = extractModelFamily(modelName);
    return family ? this.getModelsByFamily(family) : this.getAvailableModels();
  }
}
