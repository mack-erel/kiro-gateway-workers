/**
 * Model metadata cache. Port of `kiro/cache.py`.
 *
 * Stores model info (token limits, etc.) keyed by modelId, with a TTL. The
 * Python version uses an asyncio.Lock for thread safety; a Workers isolate is
 * single-threaded with no intra-request concurrency, so the lock is unnecessary
 * and methods are synchronous.
 */
import { DEFAULT_MAX_INPUT_TOKENS } from "../config";
import type { MaxInputTokensProvider } from "../streaming/core";

export class ModelInfoCache implements MaxInputTokensProvider {
  private cache: Record<string, Record<string, any>> = {};
  private lastUpdate: number | null = null;
  private readonly cacheTtlMs: number;

  /** @param cacheTtlMs TTL in milliseconds (config.modelCacheTtlMs). */
  constructor(cacheTtlMs: number) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Replace cache contents with new model data (keyed by modelId). */
  update(modelsData: Array<Record<string, any>>): void {
    const next: Record<string, Record<string, any>> = {};
    for (const model of modelsData) {
      next[model["modelId"]] = model;
    }
    this.cache = next;
    this.lastUpdate = Date.now();
  }

  get(modelId: string): Record<string, any> | undefined {
    return this.cache[modelId];
  }

  isValidModel(modelId: string): boolean {
    return modelId in this.cache;
  }

  /** Add a hidden model (not advertised by ListAvailableModels) to the cache. */
  addHiddenModel(displayName: string, internalId: string): void {
    if (!(displayName in this.cache)) {
      this.cache[displayName] = {
        modelId: displayName,
        modelName: displayName,
        description: `Hidden model (internal: ${internalId})`,
        tokenLimits: { maxInputTokens: DEFAULT_MAX_INPUT_TOKENS },
        _internal_id: internalId,
        _is_hidden: true,
      };
    }
  }

  getMaxInputTokens(modelId: string): number {
    const model = this.cache[modelId];
    if (model && model["tokenLimits"]) {
      return model["tokenLimits"]["maxInputTokens"] || DEFAULT_MAX_INPUT_TOKENS;
    }
    return DEFAULT_MAX_INPUT_TOKENS;
  }

  isEmpty(): boolean {
    return Object.keys(this.cache).length === 0;
  }

  isStale(): boolean {
    if (this.lastUpdate === null) return true;
    return Date.now() - this.lastUpdate > this.cacheTtlMs;
  }

  getAllModelIds(): string[] {
    return Object.keys(this.cache);
  }

  get size(): number {
    return Object.keys(this.cache).length;
  }

  get lastUpdateTime(): number | null {
    return this.lastUpdate;
  }
}
