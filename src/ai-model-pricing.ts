import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger, sanitizeError } from "./logger.js";

export const LITELLM_MODEL_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_PRICE_CACHE_VERSION = 1;
const LITELLM_PRICE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const LITELLM_PRICE_ENTRY_LIMIT = 20_000;
const DEFAULT_LITELLM_PRICE_REFRESH_TIMEOUT_MS = 30_000;

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

export type TokenUsagePricing = {
  estimatedCost: number | null;
  pricedModelCount: number;
  unpricedModelCount: number;
  pricingAvailable: boolean;
};

type LiteLlmPriceCacheFile = {
  version: number;
  source: string;
  updatedAt: string;
  prices: Record<string, LiteLlmModelPrice>;
};

export type LiteLlmPriceCacheOptions = {
  cachePath?: string;
  fetchImpl?: typeof fetch;
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function optionalPrice(record: Record<string, unknown>, key: string): number | undefined {
  const value = finiteNonNegative(record[key]);
  return value === null ? undefined : value;
}

export function parseLiteLlmPriceTable(payload: unknown): Map<string, LiteLlmModelPrice> {
  const record = recordValue(payload);
  const entries = recordValue(record?.prices) ?? record;
  const table = new Map<string, LiteLlmModelPrice>();
  if (!entries) return table;
  for (const [rawModelId, rawPrice] of Object.entries(entries)) {
    if (table.size >= LITELLM_PRICE_ENTRY_LIMIT || rawModelId === "sample_spec") continue;
    const modelId = normalizedModelId(rawModelId);
    const priceRecord = recordValue(rawPrice);
    if (!modelId || !priceRecord) continue;
    const inputCost = finiteNonNegative(priceRecord.input_cost_per_token);
    const outputCost = finiteNonNegative(priceRecord.output_cost_per_token);
    if (inputCost === null || outputCost === null) continue;
    const cacheReadCost = optionalPrice(priceRecord, "cache_read_input_token_cost");
    const legacyCacheReadCost = optionalPrice(priceRecord, "input_cost_per_token_cache_hit");
    const cacheCreationCost = optionalPrice(priceRecord, "cache_creation_input_token_cost");
    table.set(modelId, {
      input_cost_per_token: inputCost,
      output_cost_per_token: outputCost,
      ...(cacheReadCost === undefined ? {} : { cache_read_input_token_cost: cacheReadCost }),
      ...(legacyCacheReadCost === undefined ? {} : { input_cost_per_token_cache_hit: legacyCacheReadCost }),
      ...(cacheCreationCost === undefined ? {} : { cache_creation_input_token_cost: cacheCreationCost })
    });
  }
  return table;
}

function serializeLiteLlmPriceTable(table: LiteLlmPriceTable): Record<string, LiteLlmModelPrice> {
  return Object.fromEntries([...table.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function nextLiteLlmPriceUpdate(now: Date): Date {
  const next = new Date(now.getTime());
  next.setHours(24, 0, 0, 0);
  return next;
}

export class LiteLlmPriceCache {
  private readonly cachePath: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sourceUrl: string;
  private readonly refreshTimeoutMs: number;
  private readonly schedule: boolean;
  private readonly now: () => Date;
  private prices = new Map<string, LiteLlmModelPrice>();
  private lastSuccessfulUpdateAt: string | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private activeController: AbortController | null = null;
  private started = false;
  private disposed = false;

  constructor(options: LiteLlmPriceCacheOptions = {}) {
    this.cachePath = options.cachePath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sourceUrl = options.sourceUrl ?? LITELLM_MODEL_PRICES_URL;
    this.refreshTimeoutMs = Number.isSafeInteger(options.refreshTimeoutMs) && Number(options.refreshTimeoutMs) > 0
      ? Number(options.refreshTimeoutMs)
      : DEFAULT_LITELLM_PRICE_REFRESH_TIMEOUT_MS;
    this.schedule = options.schedule !== false;
    this.now = options.now ?? (() => new Date());
    this.loadPersistedCache();
  }

  getPriceTable(): LiteLlmPriceTable {
    return this.prices;
  }

  hasData(): boolean {
    return this.prices.size > 0;
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
    this.activeController?.abort();
    this.activeController = null;
  }

  private loadPersistedCache(): void {
    if (!this.cachePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as unknown;
      const cache = recordValue(parsed);
      const table = parseLiteLlmPriceTable(cache?.prices);
      if (cache?.version !== LITELLM_PRICE_CACHE_VERSION || table.size === 0 || typeof cache.updatedAt !== "string") {
        throw new Error("LiteLLM price cache has an invalid schema");
      }
      this.prices = table;
      this.lastSuccessfulUpdateAt = cache.updatedAt;
      logger.info("ai.litellm_price_cache.loaded", {
        cachePath: this.cachePath,
        modelCount: table.size,
        updatedAt: cache.updatedAt
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      logger.warn("ai.litellm_price_cache.load_failed", {
        cachePath: this.cachePath,
        error: sanitizeError(error)
      });
    }
  }

  private async fetchAndActivate(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);
    this.activeController = controller;
    try {
      const response = await this.fetchImpl(this.sourceUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`LiteLLM price response returned HTTP ${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > LITELLM_PRICE_RESPONSE_MAX_BYTES) {
        throw new Error("LiteLLM price response exceeded the size limit");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new Error("LiteLLM price response was not valid JSON");
      }
      const nextPrices = parseLiteLlmPriceTable(payload);
      if (nextPrices.size === 0) throw new Error("LiteLLM price response contained no valid model prices");
      const updatedAt = this.now().toISOString();
      const cache: LiteLlmPriceCacheFile = {
        version: LITELLM_PRICE_CACHE_VERSION,
        source: this.sourceUrl,
        updatedAt,
        prices: serializeLiteLlmPriceTable(nextPrices)
      };
      this.persistCache(cache);
      this.prices = nextPrices;
      this.lastSuccessfulUpdateAt = updatedAt;
      logger.info("ai.litellm_price_cache.updated", {
        cachePath: this.cachePath ?? "test-only-no-persistence",
        modelCount: nextPrices.size,
        updatedAt
      });
      return true;
    } catch (error) {
      if (!this.disposed) {
        logger.warn("ai.litellm_price_cache.refresh_failed", {
          cachePath: this.cachePath ?? "test-only-no-persistence",
          hasHistoricalCache: this.hasData(),
          lastSuccessfulUpdateAt: this.lastSuccessfulUpdateAt,
          error: sanitizeError(error)
        });
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private persistCache(cache: LiteLlmPriceCacheFile): void {
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
    logger.info("ai.litellm_price_cache.scheduled", {
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
  return normalized ? priceTable.get(normalized) ?? null : null;
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
