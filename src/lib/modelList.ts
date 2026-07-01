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

/** Format model IDs into the Anthropic `/v1/models` shape. */
export function toAnthropicModelList(ids: string[]): AnthropicModelList {
  const createdAt = new Date(nowSeconds() * 1000).toISOString();
  const data: AnthropicModelObject[] = ids.map((id) => ({
    type: "model" as const,
    id,
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
