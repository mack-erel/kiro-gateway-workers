/**
 * Shared model-list resolution and per-agent formatting.
 *
 * Both the OpenAI `/v1/models` route and the MCP `list_kiro_models` tool need
 * the same discovered model IDs, rendered into each agent's native shape:
 *  - OpenAI:    { object: "list", data: [{ id, object: "model", ... }] }
 *  - Anthropic: { data: [{ type: "model", id, display_name, created_at }], ... }
 *
 * Keeping the resolution and formatters here guarantees the MCP tool advertises
 * exactly the same catalog as the HTTP endpoint.
 */
import type { Config } from "../config";
import {
  HIDDEN_MODELS,
  MODEL_ALIASES,
  HIDDEN_FROM_LIST,
  FALLBACK_MODELS,
  DISCOVERY_PREFIX,
} from "../config";
import { getPassthroughSession } from "../auth/passthroughSession";
import { ModelInfoCache } from "./cache";
import { ModelResolver } from "./modelResolver";

/**
 * Resolve the advertised model IDs for a client key. Discovers the live list
 * from the management endpoint (cached per session), then applies the same
 * alias/hidden policy as `/v1/models`. Falls back to the static list when no
 * key is available (e.g. proxy mode / discovery failure).
 */
export async function resolveAvailableModelIds(
  apiKey: string | null,
  config: Config,
): Promise<string[]> {
  if (apiKey) {
    const session = await getPassthroughSession(
      apiKey,
      config.apiRegion,
      config.modelCacheTtlMs,
    );
    const resolver = new ModelResolver(
      session.modelCache,
      HIDDEN_MODELS,
      MODEL_ALIASES,
      HIDDEN_FROM_LIST,
    );
    return resolver.getAvailableModels();
  }

  const modelCache = new ModelInfoCache(config.modelCacheTtlMs);
  modelCache.update(FALLBACK_MODELS);
  const resolver = new ModelResolver(
    modelCache,
    HIDDEN_MODELS,
    MODEL_ALIASES,
    HIDDEN_FROM_LIST,
  );
  return resolver.getAvailableModels();
}

/** Current unix time in seconds (single value shared across a formatted list). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Derive a human-friendly display name from a model ID.
 * `claude-sonnet-4.5` → "Claude Sonnet 4.5"; `qwen3-coder-next` → "Qwen3 Coder Next".
 */
export function deriveDisplayName(id: string): string {
  return id
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export interface OpenAiModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  description: string;
}

export interface OpenAiModelList {
  object: "list";
  data: OpenAiModelObject[];
}

/** Format model IDs into the OpenAI `/v1/models` shape. */
export function toOpenAiModelList(ids: string[]): OpenAiModelList {
  const created = nowSeconds();
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "anthropic",
      description: "Claude model via Kiro API",
    })),
  };
}

export interface AnthropicModelObject {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
}

export interface AnthropicModelList {
  data: AnthropicModelObject[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

/**
 * True when Claude Code's gateway model discovery keeps an id as-is. The picker
 * ignores every entry whose id does not start with `claude` or `anthropic`.
 */
function isDiscoverable(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.startsWith("claude") || lower.startsWith("anthropic");
}

export interface AnthropicModelListOptions {
  /**
   * Rename non-Claude ids to `anthropic-<id>` so Claude Code's gateway model
   * discovery keeps them (it drops every id not starting with `claude`/
   * `anthropic`). Only the HTTP `/v1/models` response is subject to that
   * filter, so this is opt-in: callers with no filter — the MCP
   * `list_kiro_models` tool — would otherwise report a name for the model that
   * neither their own text summary nor the OpenAI shape agrees with.
   * `ModelResolver` strips the prefix back off on the request path, so a
   * prefixed id remains usable wherever it surfaces.
   */
  discoveryPrefix?: boolean;
}

/**
 * Format model IDs into the Anthropic `/v1/models` shape.
 *
 * The display name is always derived from the raw id, so the prefix stays a
 * wire detail and never reaches the picker as "Anthropic Glm 5".
 *
 * The OpenAI shape is never prefixed — its clients have no discovery filter,
 * and renaming there would break every existing `glm-5` config.
 */
export function toAnthropicModelList(
  ids: string[],
  options: AnthropicModelListOptions = {},
): AnthropicModelList {
  const createdAt = new Date(nowSeconds() * 1000).toISOString();
  const prefix = options.discoveryPrefix ?? false;
  const data: AnthropicModelObject[] = ids.map((id) => ({
    type: "model" as const,
    id: prefix && !isDiscoverable(id) ? DISCOVERY_PREFIX + id : id,
    display_name: deriveDisplayName(id),
    created_at: createdAt,
  }));
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}
