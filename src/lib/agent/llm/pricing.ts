import type { ModelPricing } from "./pricing-utils";
import {
  lookupPricing,
  convertCatalog,
  selectPricingRate,
  fetchWithRetry,
  fetchCustomCatalog,
  tokenCount,
  finite,
} from "./pricing-utils";

export const DEFAULT_UNKNOWN_MODEL_PRICE: ModelPricing = {
  in: 10,
  out: 30,
  uncatalogued: true,
};

export const CONSERVATIVE_DEFAULT_PRICING = DEFAULT_UNKNOWN_MODEL_PRICE;

let pricingOverride: Record<string, ModelPricing> = {};

const pricingCache = new Map<string, ModelPricing>();

const warnedUncataloguedModels = new Set<string>();

let pricingLoading = false;

let pricingLoaded = false;

let lastPricingError: Error | null = null;

export function getLastPricingError(): Error | null {
  return lastPricingError;
}

let lastRefreshAttempt = 0;

const REFRESH_COOLDOWN_MS = 30_000;

const MAX_PRICING_CACHE = 256;
const MAX_WARNED_MODELS = 128;

function evictPricingCache(): void {
  if (pricingCache.size >= MAX_PRICING_CACHE) {
    const oldest = pricingCache.keys().next().value;
    if (oldest !== undefined) pricingCache.delete(oldest);
  }
}

function maybeClearWarnedModels(): void {
  if (warnedUncataloguedModels.size >= MAX_WARNED_MODELS) {
    warnedUncataloguedModels.clear();
  }
}

export async function refreshPricingFromCatalog(): Promise<void> {
  try {
    const url = typeof process !== "undefined" ? process.env?.COWORK_MODEL_CATALOG_URL : undefined;
    let table: Record<string, ModelPricing> = {};
    if (url) {
      table = await fetchCustomCatalog(url);
    } else {
      const { fetchCatalog, catalogFetchSucceeded } = await import("./catalog");
      const catalog = await fetchWithRetry(() => fetchCatalog(true));
      table = convertCatalog(catalog);
  // `fetchCatalog` never throws by contract (it falls back to the bundled
  // snapshot), so the live-merge flag is the only way to detect a failed
  // fetch here. Without this check `pricingLoaded` would be set on a
  // fallback and the lazy refresh (guarded on `!pricingLoaded`) would never
  // re-fire after a transient startup network failure. The bundled rates are
  // still applied below — only the "loaded" flag is withheld.
      if (!catalogFetchSucceeded()) {
        throw new Error("live model catalog fetch failed (bundled snapshot in use)");
      }
    }
    pricingOverride = { ...pricingOverride, ...table };
    pricingLoaded = true;
    pricingCache.clear();
    lastPricingError = null;
  } catch (err) {
    lastPricingError = err instanceof Error ? err : new Error(String(err));
    console.warn("[pricing] refreshPricingFromCatalog failed:", lastPricingError.message);
  }
}

function setPricingCache(key: string, value: ModelPricing): void {
  evictPricingCache();
  pricingCache.set(key, value);
}

export function getPricingForModel(model: string, providerId?: string): ModelPricing {
  const cacheKey = providerId ? `${providerId}::${model}` : model;
  const cached = pricingCache.get(cacheKey);
  if (cached) return cached;

  const override = lookupPricing(pricingOverride, model, providerId);
  if (override) {
    setPricingCache(cacheKey, override);
    return override;
  }

  if (
    !pricingLoaded &&
    !pricingLoading &&
    Date.now() - lastRefreshAttempt > REFRESH_COOLDOWN_MS
  ) {
    pricingLoading = true;
    lastRefreshAttempt = Date.now();
    void refreshPricingFromCatalog()
      .finally(() => {
        pricingLoading = false;
      });
  }

  const result = { ...DEFAULT_UNKNOWN_MODEL_PRICE };
  if (!warnedUncataloguedModels.has(model)) {
    maybeClearWarnedModels();
    warnedUncataloguedModels.add(model);
    const displayName = model.length > 60 ? model.slice(0, 57) + "..." : model;
    console.warn(
      `[pricing] No catalogued price for model "${displayName}". Falling back to ` +
        `DEFAULT_UNKNOWN_MODEL_PRICE ($${DEFAULT_UNKNOWN_MODEL_PRICE.in}/` +
        `$${DEFAULT_UNKNOWN_MODEL_PRICE.out} per 1M tokens, flagged uncatalogued). ` +
        `The cost cap still applies, but consider adding this model to the catalog.`
    );
  }
  setPricingCache(cacheKey, result);
  return result;
}

export function __resetPricingForTests(): void {
  pricingOverride = {};
  pricingLoaded = false;
  pricingCache.clear();
  warnedUncataloguedModels.clear();
  pricingLoading = false;
  lastRefreshAttempt = 0;
  lastPricingError = null;
}

interface EstimateCostOptions {
  model: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cachedWriteInputTokens?: number;
  completionTokens?: number;
  providerId?: string;
  /** Context (input) token count driving tiered-rate selection. Defaults to
   * `tokensIn` when omitted (opencode derives context tokens from input tokens). */
  contextTokens?: number;
}

export function estimateCost(
  modelOrOpts: string | EstimateCostOptions,
  tokensIn?: number,
  tokensOut?: number,
  reasoningTokens?: number,
  cachedInputTokens?: number,
  cachedWriteInputTokens?: number,
  completionTokens?: number,
  providerId?: string
): number {
  const opts: EstimateCostOptions =
    typeof modelOrOpts === "string"
      ? {
          model: modelOrOpts,
          tokensIn: tokensIn ?? 0,
          tokensOut: tokensOut ?? 0,
          reasoningTokens,
          cachedInputTokens,
          cachedWriteInputTokens,
          completionTokens,
          providerId,
        }
      : modelOrOpts;
  const { model, providerId: pid } = opts;
  const tIn = tokenCount(opts.tokensIn);
  const tOut = tokenCount(opts.tokensOut);
  const rTokens = tokenCount(opts.reasoningTokens);
  const cRead = tokenCount(opts.cachedInputTokens);
  const cWrite = tokenCount(opts.cachedWriteInputTokens);
  const compTokens = opts.completionTokens !== undefined ? tokenCount(opts.completionTokens) : undefined;

  const contextTokens = opts.contextTokens !== undefined ? tokenCount(opts.contextTokens) : tIn;
  const rate = selectPricingRate(getPricingForModel(model, pid), contextTokens);

  const cachedRead = Math.min(cRead, tIn);
  const cachedWrite = Math.min(
    cWrite,
    Math.max(0, tIn - cachedRead),
  );
  const freshInput = Math.max(0, tIn - cachedRead - cachedWrite);

  const visibleOut =
    compTokens !== undefined
      ? Math.max(0, compTokens)
      : Math.max(0, tOut - rTokens);

  const def = DEFAULT_UNKNOWN_MODEL_PRICE;
  const inRate = finite(rate.in, def.in);
  const cacheReadRate = finite(rate.cacheRead, inRate);
  const cacheWriteRate = finite(rate.cacheWrite, inRate);
  const outRate = finite(rate.out, def.out);
  const reasoningRate = finite(rate.reasoning, outRate);

  return (
    (freshInput / 1_000_000) * inRate +
    (cachedRead / 1_000_000) * cacheReadRate +
    (cachedWrite / 1_000_000) * cacheWriteRate +
    (visibleOut / 1_000_000) * outRate +
    (rTokens / 1_000_000) * reasoningRate
  );
}
