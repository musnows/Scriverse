import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger, sanitizeError } from "./logger.js";

export const LITELLM_MODEL_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const OPENROUTER_MODEL_PRICES_URL = "https://openrouter.ai/api/v1/models";
export const MODELS_DEV_MODEL_PRICES_URL = "https://models.dev/api.json";
export const PUBLIC_PROVIDER_CONF_PRICES_URL = "https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/refs/heads/dev/dist/all.json";
export const MODEL_PRICE_SOURCE_ORDER = ["litellm", "openrouter", "models.dev", "public-provider-conf"] as const;
export type ModelPriceSource = typeof MODEL_PRICE_SOURCE_ORDER[number];

const MODEL_PRICE_CACHE_VERSION = 2;
const MODEL_PRICE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const MODEL_PRICE_ENTRY_LIMIT = 100_000;
const DEFAULT_MODEL_PRICE_REFRESH_TIMEOUT_MS = 30_000;
const PER_MILLION_TOKENS = 1_000_000;

const MODEL_PRICE_SOURCE_DEFINITIONS: readonly { source: ModelPriceSource; url: string }[] = [
  { source: "litellm", url: LITELLM_MODEL_PRICES_URL },
  { source: "openrouter", url: OPENROUTER_MODEL_PRICES_URL },
  { source: "models.dev", url: MODELS_DEV_MODEL_PRICES_URL },
  { source: "public-provider-conf", url: PUBLIC_PROVIDER_CONF_PRICES_URL }
];

export type ModelTokenUsage = {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
};

export type LiteLlmModelPrice = {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_cache_hit?: number;
  cache_creation_input_token_cost?: number;
};

export type LiteLlmPriceTable = ReadonlyMap<string, LiteLlmModelPrice>;

export type ModelPriceSourceStatus = {
  source: ModelPriceSource;
  url: string;
  modelCount: number;
  updatedAt: string | null;
  lastRefreshSucceeded: boolean | null;
};

export type TokenUsagePricing = {
  estimatedCost: number | null;
  pricedModelCount: number;
  unpricedModelCount: number;
  pricingAvailable: boolean;
};

type ModelPriceSourceCacheFile = {
  source: ModelPriceSource;
  url: string;
  updatedAt: string;
  prices: Record<string, LiteLlmModelPrice>;
};

type ModelPriceCacheFile = {
  version: number;
  updatedAt: string;
  sources: Partial<Record<ModelPriceSource, ModelPriceSourceCacheFile>>;
};

type LegacyLiteLlmPriceCacheFile = {
  version: number;
  source: string;
  updatedAt: string;
  prices: Record<string, LiteLlmModelPrice>;
};

export type LiteLlmPriceCacheOptions = {
  cachePath?: string;
  fetchImpl?: typeof fetch;
  sourceUrls?: Partial<Record<ModelPriceSource, string>>;
  sourceUrl?: string;
  refreshTimeoutMs?: number;
  schedule?: boolean;
  now?: () => Date;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function optionalPrice(record: Record<string, unknown>, key: string): number | undefined {
  const value = finiteNonNegative(record[key]);
  return value === null ? undefined : value;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function addPrice(table: Map<string, LiteLlmModelPrice>, modelId: string, price: LiteLlmModelPrice): void {
  const normalized = normalizedModelId(modelId);
  if (table.size >= MODEL_PRICE_ENTRY_LIMIT || !normalized || table.has(normalized)) return;
  table.set(normalized, price);
}

function collectionEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((entry, index) => [String(index), entry]);
  const record = recordValue(value);
  return record ? Object.entries(record) : [];
}

function priceFromPerMillionCost(record: Record<string, unknown>): LiteLlmModelPrice | null {
  const inputCost = finiteNonNegative(record.input);
  const outputCost = finiteNonNegative(record.output);
  if (inputCost === null || outputCost === null) return null;
  const cacheReadCost = finiteNonNegative(record.cache_read);
  const cacheWriteCost = finiteNonNegative(record.cache_write);
  return {
    input_cost_per_token: inputCost / PER_MILLION_TOKENS,
    output_cost_per_token: outputCost / PER_MILLION_TOKENS,
    ...(cacheReadCost === null ? {} : { cache_read_input_token_cost: cacheReadCost / PER_MILLION_TOKENS }),
    ...(cacheWriteCost === null ? {} : { cache_creation_input_token_cost: cacheWriteCost / PER_MILLION_TOKENS })
  };
}

export function parseLiteLlmPriceTable(payload: unknown): Map<string, LiteLlmModelPrice> {
  const record = recordValue(payload);
  const entries = recordValue(record?.prices) ?? record;
  const table = new Map<string, LiteLlmModelPrice>();
  if (!entries) return table;
  for (const [rawModelId, rawPrice] of Object.entries(entries)) {
    if (rawModelId === "sample_spec") continue;
    const modelId = normalizedModelId(rawModelId);
    const priceRecord = recordValue(rawPrice);
    if (!modelId || !priceRecord) continue;
    const inputCost = finiteNonNegative(priceRecord.input_cost_per_token);
    const outputCost = finiteNonNegative(priceRecord.output_cost_per_token);
    if (inputCost === null || outputCost === null) continue;
    const cacheReadCost = optionalPrice(priceRecord, "cache_read_input_token_cost");
    const legacyCacheReadCost = optionalPrice(priceRecord, "input_cost_per_token_cache_hit");
    const cacheCreationCost = optionalPrice(priceRecord, "cache_creation_input_token_cost");
    addPrice(table, modelId, {
      input_cost_per_token: inputCost,
      output_cost_per_token: outputCost,
      ...(cacheReadCost === undefined ? {} : { cache_read_input_token_cost: cacheReadCost }),
      ...(legacyCacheReadCost === undefined ? {} : { input_cost_per_token_cache_hit: legacyCacheReadCost }),
      ...(cacheCreationCost === undefined ? {} : { cache_creation_input_token_cost: cacheCreationCost })
    });
  }
  return table;
}

export function parseOpenRouterPriceTable(payload: unknown): Map<string, LiteLlmModelPrice> {
  const record = recordValue(payload);
  const models = Array.isArray(record?.data) ? record.data : [];
  const table = new Map<string, LiteLlmModelPrice>();
  for (const rawModel of models) {
    const model = recordValue(rawModel);
    const modelId = nonEmptyString(model?.id);
    const pricing = recordValue(model?.pricing);
    if (!modelId || !pricing) continue;
    const inputCost = finiteNonNegative(pricing.prompt);
    const outputCost = finiteNonNegative(pricing.completion);
    if (inputCost === null || outputCost === null) continue;
    const cacheReadCost = finiteNonNegative(pricing.input_cache_read);
    const cacheWriteCost = finiteNonNegative(pricing.input_cache_write);
    addPrice(table, modelId, {
      input_cost_per_token: inputCost,
      output_cost_per_token: outputCost,
      ...(cacheReadCost === null ? {} : { cache_read_input_token_cost: cacheReadCost }),
      ...(cacheWriteCost === null ? {} : { cache_creation_input_token_cost: cacheWriteCost })
    });
  }
  return table;
}

function parseProviderModelPriceTable(payload: unknown, providerField: "providers" | null): Map<string, LiteLlmModelPrice> {
  const record = recordValue(payload);
  const providers = providerField ? recordValue(record?.[providerField]) : record;
  const table = new Map<string, LiteLlmModelPrice>();
  if (!providers) return table;
  for (const [rawProviderId, rawProvider] of Object.entries(providers)) {
    const provider = recordValue(rawProvider);
    const providerId = nonEmptyString(provider?.id) ?? rawProviderId;
    for (const [rawModelId, rawModel] of collectionEntries(provider?.models)) {
      const model = recordValue(rawModel);
      const modelId = nonEmptyString(model?.id) ?? (rawModelId.match(/^\d+$/u) ? null : rawModelId);
      const cost = recordValue(model?.cost);
      if (!modelId || !cost) continue;
      const price = priceFromPerMillionCost(cost);
      if (!price) continue;
      addPrice(table, `${providerId}/${modelId}`, price);
    }
  }
  return table;
}

export function parseModelsDevPriceTable(payload: unknown): Map<string, LiteLlmModelPrice> {
  return parseProviderModelPriceTable(payload, null);
}

export function parsePublicProviderConfPriceTable(payload: unknown): Map<string, LiteLlmModelPrice> {
  return parseProviderModelPriceTable(payload, "providers");
}

function parsePriceTable(source: ModelPriceSource, payload: unknown): Map<string, LiteLlmModelPrice> {
  if (source === "litellm") return parseLiteLlmPriceTable(payload);
  if (source === "openrouter") return parseOpenRouterPriceTable(payload);
  if (source === "models.dev") return parseModelsDevPriceTable(payload);
  return parsePublicProviderConfPriceTable(payload);
}

function serializeLiteLlmPriceTable(table: LiteLlmPriceTable): Record<string, LiteLlmModelPrice> {
  return Object.fromEntries(table);
}

function serializeSourceTables(
  sourceDefinitions: readonly { source: ModelPriceSource; url: string }[],
  sourceTables: ReadonlyMap<ModelPriceSource, LiteLlmPriceTable>,
  sourceUpdatedAt: ReadonlyMap<ModelPriceSource, string>
): Partial<Record<ModelPriceSource, ModelPriceSourceCacheFile>> {
  const sources: Partial<Record<ModelPriceSource, ModelPriceSourceCacheFile>> = {};
  for (const definition of sourceDefinitions) {
    const table = sourceTables.get(definition.source);
    const updatedAt = sourceUpdatedAt.get(definition.source);
    if (!table || table.size === 0 || !updatedAt) continue;
    sources[definition.source] = {
      source: definition.source,
      url: definition.url,
      updatedAt,
      prices: serializeLiteLlmPriceTable(table)
    };
  }
  return sources;
}

export function nextLiteLlmPriceUpdate(now: Date): Date {
  const next = new Date(now.getTime());
  next.setHours(24, 0, 0, 0);
  return next;
}

export class LiteLlmPriceCache {
  private readonly cachePath: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sourceDefinitions: readonly { source: ModelPriceSource; url: string }[];
  private readonly refreshTimeoutMs: number;
  private readonly schedule: boolean;
  private readonly now: () => Date;
  private prices = new Map<string, LiteLlmModelPrice>();
  private sourceTables = new Map<ModelPriceSource, Map<string, LiteLlmModelPrice>>();
  private sourceUpdatedAt = new Map<ModelPriceSource, string>();
  private sourceRefreshStatus = new Map<ModelPriceSource, boolean | null>();
  private lastSuccessfulUpdateAt: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private activeControllers = new Set<AbortController>();
  private started = false;
  private disposed = false;

  constructor(options: LiteLlmPriceCacheOptions = {}) {
    this.cachePath = options.cachePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sourceDefinitions = MODEL_PRICE_SOURCE_DEFINITIONS.map((definition) => ({
      ...definition,
      url: options.sourceUrls?.[definition.source]
        ?? (definition.source === "litellm" ? options.sourceUrl : undefined)
        ?? definition.url
    }));
    this.refreshTimeoutMs = Number.isSafeInteger(options.refreshTimeoutMs) && Number(options.refreshTimeoutMs) > 0
      ? Number(options.refreshTimeoutMs)
      : DEFAULT_MODEL_PRICE_REFRESH_TIMEOUT_MS;
    this.schedule = options.schedule !== false;
    this.now = options.now ?? (() => new Date());
    for (const definition of this.sourceDefinitions) this.sourceRefreshStatus.set(definition.source, null);
    this.loadPersistedCache();
  }

  getPriceTable(): LiteLlmPriceTable {
    return this.prices;
  }

  hasData(): boolean {
    return this.prices.size > 0;
  }

  getSourceStatuses(): ModelPriceSourceStatus[] {
    return this.sourceDefinitions.map((definition) => ({
      source: definition.source,
      url: definition.url,
      modelCount: this.sourceTables.get(definition.source)?.size ?? 0,
      updatedAt: this.sourceUpdatedAt.get(definition.source) ?? null,
      lastRefreshSucceeded: this.sourceRefreshStatus.get(definition.source) ?? null
    }));
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.schedule) this.scheduleNextUpdate();
    void this.refresh();
  }

  async refresh(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.refreshPromise) return this.refreshPromise;
    const refreshPromise = this.fetchAndActivate();
    this.refreshPromise = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  private loadPersistedCache(): void {
    if (!this.cachePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as unknown;
      const cache = recordValue(parsed);
      if (cache?.version === MODEL_PRICE_CACHE_VERSION) {
        const sources = recordValue(cache.sources);
        if (!sources || typeof cache.updatedAt !== "string") throw new Error("Model price cache has an invalid schema");
        for (const definition of this.sourceDefinitions) {
          const sourceCache = recordValue(sources[definition.source]);
          const table = parseLiteLlmPriceTable(sourceCache?.prices);
          if (table.size === 0 || typeof sourceCache?.updatedAt !== "string") continue;
          this.sourceTables.set(definition.source, table);
          this.sourceUpdatedAt.set(definition.source, sourceCache.updatedAt);
        }
        this.rebuildPriceTable(this.sourceTables);
        if (!this.hasData()) throw new Error("Model price cache contains no valid prices");
        this.lastSuccessfulUpdateAt = cache.updatedAt;
        logger.info("ai.model_price_cache.loaded", {
          cachePath: this.cachePath,
          modelCount: this.prices.size,
          updatedAt: cache.updatedAt
        });
        return;
      }

      const legacyCache = cache as unknown as Partial<LegacyLiteLlmPriceCacheFile>;
      const legacyTable = parseLiteLlmPriceTable(legacyCache.prices);
      if (legacyCache.version !== 1 || legacyTable.size === 0 || typeof legacyCache.updatedAt !== "string") {
        throw new Error("Model price cache has an invalid schema");
      }
      this.sourceTables.set("litellm", legacyTable);
      this.sourceUpdatedAt.set("litellm", legacyCache.updatedAt);
      this.rebuildPriceTable(this.sourceTables);
      this.lastSuccessfulUpdateAt = legacyCache.updatedAt;
      logger.info("ai.model_price_cache.loaded_legacy", {
        cachePath: this.cachePath,
        modelCount: this.prices.size,
        updatedAt: legacyCache.updatedAt
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      logger.warn("ai.model_price_cache.load_failed", {
        cachePath: this.cachePath,
        error: sanitizeError(error)
      });
    }
  }

  private async fetchSource(definition: { source: ModelPriceSource; url: string }): Promise<{
    source: ModelPriceSource;
    table: Map<string, LiteLlmModelPrice>;
    updatedAt: string;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);
    this.activeControllers.add(controller);
    try {
      const response = await this.fetchImpl(definition.url, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`${definition.source} price response returned HTTP ${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MODEL_PRICE_RESPONSE_MAX_BYTES) {
        throw new Error(`${definition.source} price response exceeded the size limit`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new Error(`${definition.source} price response was not valid JSON`);
      }
      const table = parsePriceTable(definition.source, payload);
      if (table.size === 0) throw new Error(`${definition.source} price response contained no valid model prices`);
      return { source: definition.source, table, updatedAt: this.now().toISOString() };
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private rebuildPriceTable(sourceTables: ReadonlyMap<ModelPriceSource, LiteLlmPriceTable>): Map<string, LiteLlmModelPrice> {
    const merged = new Map<string, LiteLlmModelPrice>();
    for (const definition of this.sourceDefinitions) {
      const table = sourceTables.get(definition.source);
      if (!table) continue;
      for (const [modelId, price] of table) {
        if (!merged.has(modelId)) merged.set(modelId, price);
      }
    }
    this.prices = merged;
    return merged;
  }

  private buildCache(updatedAt: string, sourceTables: ReadonlyMap<ModelPriceSource, LiteLlmPriceTable>, sourceUpdatedAt: ReadonlyMap<ModelPriceSource, string>): ModelPriceCacheFile {
    return {
      version: MODEL_PRICE_CACHE_VERSION,
      updatedAt,
      sources: serializeSourceTables(this.sourceDefinitions, sourceTables, sourceUpdatedAt)
    };
  }

  private async fetchAndActivate(): Promise<boolean> {
    const results = await Promise.all(this.sourceDefinitions.map(async (definition) => {
      try {
        const result = await this.fetchSource(definition);
        return { success: true as const, result };
      } catch (error) {
        this.sourceRefreshStatus.set(definition.source, false);
        if (!this.disposed) {
          logger.warn("ai.model_price_source.refresh_failed", {
            source: definition.source,
            url: definition.url,
            hasHistoricalCache: (this.sourceTables.get(definition.source)?.size ?? 0) > 0,
            lastSuccessfulUpdateAt: this.sourceUpdatedAt.get(definition.source) ?? null,
            error: sanitizeError(error)
          });
        }
        return { success: false as const, source: definition.source };
      }
    }));
    const successfulResults = results.filter((result): result is { success: true; result: { source: ModelPriceSource; table: Map<string, LiteLlmModelPrice>; updatedAt: string } } => result.success);
    if (successfulResults.length === 0) {
      logger.warn("ai.model_price_cache.refresh_failed", {
        cachePath: this.cachePath ?? "test-only-no-persistence",
        hasHistoricalCache: this.hasData(),
        lastSuccessfulUpdateAt: this.lastSuccessfulUpdateAt,
        successfulSourceCount: 0
      });
      return false;
    }

    const nextSourceTables = new Map(this.sourceTables);
    const nextSourceUpdatedAt = new Map(this.sourceUpdatedAt);
    for (const { result } of successfulResults) {
      nextSourceTables.set(result.source, result.table);
      nextSourceUpdatedAt.set(result.source, result.updatedAt);
      this.sourceRefreshStatus.set(result.source, true);
    }
    const updatedAt = this.now().toISOString();
    const nextPrices = this.rebuildPriceTable(nextSourceTables);
    try {
      this.persistCache(this.buildCache(updatedAt, nextSourceTables, nextSourceUpdatedAt));
    } catch (error) {
      this.rebuildPriceTable(this.sourceTables);
      logger.warn("ai.model_price_cache.persist_failed", {
        cachePath: this.cachePath ?? "test-only-no-persistence",
        error: sanitizeError(error)
      });
      return false;
    }
    this.sourceTables = nextSourceTables;
    this.sourceUpdatedAt = nextSourceUpdatedAt;
    this.prices = nextPrices;
    this.lastSuccessfulUpdateAt = updatedAt;
    logger.info("ai.model_price_cache.updated", {
      cachePath: this.cachePath ?? "test-only-no-persistence",
      modelCount: this.prices.size,
      updatedAt,
      successfulSources: successfulResults.map(({ result }) => result.source)
    });
    return true;
  }

  private persistCache(cache: ModelPriceCacheFile): void {
    if (!this.cachePath) return;
    const directory = dirname(this.cachePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.cachePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.cachePath);
      chmodSync(this.cachePath, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 临时文件清理失败不覆盖真正的写入错误，下一次更新会使用新的临时文件。
      }
      throw error;
    }
  }

  private scheduleNextUpdate(): void {
    if (this.disposed || !this.started || !this.schedule) return;
    const current = this.now();
    const next = nextLiteLlmPriceUpdate(current);
    const delayMs = Math.max(1, next.getTime() - current.getTime());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().finally(() => this.scheduleNextUpdate());
    }, delayMs);
    this.refreshTimer.unref?.();
    logger.info("ai.model_price_cache.scheduled", {
      nextUpdateAt: next.toISOString(),
      delayMs
    });
  }
}

function usageTokenCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function modelPrice(modelId: string, priceTable: LiteLlmPriceTable): LiteLlmModelPrice | null {
  const normalized = normalizedModelId(modelId);
  if (!normalized) return null;
  const exact = priceTable.get(normalized);
  if (exact) return exact;
  for (const [candidateModelId, price] of priceTable) {
    if (normalizedModelId(candidateModelId).includes(normalized)) return price;
  }
  return null;
}

function cacheReadInputTokenPrice(price: LiteLlmModelPrice): number {
  return price.cache_read_input_token_cost
    ?? price.input_cost_per_token_cache_hit
    ?? price.input_cost_per_token;
}

function cacheCreationInputTokenPrice(price: LiteLlmModelPrice): number {
  return price.cache_creation_input_token_cost ?? price.input_cost_per_token;
}

export function estimateLiteLlmUsageCost(
  modelUsages: readonly ModelTokenUsage[],
  priceTable: LiteLlmPriceTable = new Map()
): TokenUsagePricing {
  let estimatedCost = 0;
  let pricedModelCount = 0;
  let unpricedModelCount = 0;

  for (const usage of modelUsages) {
    const price = modelPrice(usage.modelId, priceTable);
    if (!price) {
      unpricedModelCount += 1;
      continue;
    }
    pricedModelCount += 1;
    const inputTokens = usageTokenCount(usage.inputTokens);
    const outputTokens = usageTokenCount(usage.outputTokens);
    const cachedInputTokens = Math.min(inputTokens, usageTokenCount(usage.cachedInputTokens));
    const cacheWriteInputTokens = Math.min(
      Math.max(0, inputTokens - cachedInputTokens),
      usageTokenCount(usage.cacheWriteInputTokens)
    );
    const directInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens);
    estimatedCost += directInputTokens * price.input_cost_per_token;
    estimatedCost += cachedInputTokens * cacheReadInputTokenPrice(price);
    estimatedCost += cacheWriteInputTokens * cacheCreationInputTokenPrice(price);
    estimatedCost += outputTokens * price.output_cost_per_token;
  }

  return {
    estimatedCost: pricedModelCount > 0 || modelUsages.length === 0 ? estimatedCost : null,
    pricedModelCount,
    unpricedModelCount,
    pricingAvailable: priceTable.size > 0
  };
}
