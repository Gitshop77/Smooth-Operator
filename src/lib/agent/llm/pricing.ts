/**
 * Pricing — the single source of truth for LLM token costs.
 *
 * This module is imported by:
 *   - the orchestrator (for cost-cap enforcement via `estimateCost`)
 *   - every provider (for per-call `usage.costUsd` reporting)
 *
 * Prices are per 1M tokens (USD). The authoritative source is the LIVE
 * models.dev catalog, hydrated at runtime via {@link refreshPricingFromCatalog}.
 * Until (or unless) the catalog is loaded, unknown models fall back to
 * {@link CONSERVATIVE_DEFAULT_PRICING} (in: $10 / out: $30, flagged
 * `uncatalogued`) so the cost cap still trips — an uncatalogued model is NEVER
 * billed as free.
 *
 * There is intentionally NO static pricing table in this module. The
 * models.dev catalog (see {@link refreshPricingFromCatalog}) is the source of
 * truth and may override any rate at runtime. Models with reasoning tokens
 * bill those tokens at the `reasoning` rate when present, otherwise falling
 * back to `out` (models.dev has no reasoning-cost field, so the catalog never
 * sets `reasoning`).
 */

import type { Catalog } from "./catalog";

export interface ModelPricing {
  /** Input (prompt) tokens — per 1M tokens, USD. */
  readonly in: number;
  /** Output (completion) tokens — per 1M tokens, USD. */
  readonly out: number;
  /** Reasoning/thinking tokens — per 1M tokens, USD (optional; falls back to `out`). */
  readonly reasoning?: number;
  /** Cache read tokens — per 1M tokens, USD (optional). */
  readonly cacheRead?: number;
  /** Cache write tokens — per 1M tokens, USD (optional). */
  readonly cacheWrite?: number;
  /**
   * True when this pricing came from the conservative fallback for an
   * uncatalogued model (the model was NOT found in the live catalog override).
   * Consumers may use this to ensure cost caps still trip for unknown models —
   * an uncatalogued model is NEVER billed as free.
   */
  readonly uncatalogued?: boolean;
}

/**
 * Conservative pricing used for models NOT found in the live catalog override.
 * A missing model must NEVER be billed as free — doing so defeats the cost cap
 * and allows unbounded spend. We therefore default unknown models to a
 * clearly-expensive rate (in: $10 / out: $30 per 1M tokens, roughly GPT-4-class
 * pricing) and flag them `uncatalogued: true` so callers that want to be
 * stricter can block instead of bill.
 *
 * This is the canonical name (F-02a). `CONSERVATIVE_DEFAULT_PRICING` is kept
 * as a backwards-compatible alias so existing importers keep working.
 */
export const DEFAULT_UNKNOWN_MODEL_PRICE: ModelPricing = {
  in: 10,
  out: 30,
  uncatalogued: true,
};

/** Backwards-compatible alias for {@link DEFAULT_UNKNOWN_MODEL_PRICE}. */
export const CONSERVATIVE_DEFAULT_PRICING = DEFAULT_UNKNOWN_MODEL_PRICE;

/**
 * Live catalog override table (populated by {@link refreshPricingFromCatalog}),
 * keyed by lowercased model id. This is the ONLY pricing source after the
 * catalog is hydrated; until then the conservative default applies.
 */
let pricingOverride: Record<string, ModelPricing> = {};

/**
 * Memo of {@link getPricingForModel} results, keyed by the requested model id.
 * Avoids the repeated O(N) substring scan over the pricing tables on the
 * hot cost path (estimateCost runs on every LLM call). Cleared whenever the
 * live catalog override is refreshed so updated rates win.
 */
const pricingCache = new Map<string, ModelPricing>();

/**
 * Models already warned about as uncatalogued. Keeps the fallback warning
 * quiet — emitted at most once per distinct model id so a long run
 * against an unpriced model doesn't spam the console on every token estimate.
 */
const warnedUncataloguedModels = new Set<string>();

/** True while a background {@link refreshPricingFromCatalog} is in flight. */
let pricingLoading = false;

/** Substring (case-insensitive) lookup over a pricing table. */
function lookupPricing(table: Record<string, ModelPricing>, model: string): ModelPricing | undefined {
  const m = model.toLowerCase();
  for (const [key, rate] of Object.entries(table)) {
    if (m.includes(key)) return rate;
  }
  return undefined;
}

/**
 * Convert a models.dev-shaped catalog into a lowercased pricing table.
 * Only models that declare a `cost` block contribute a rate.
 */
function convertCatalog(catalog: Catalog): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider.models)) {
      if (!model.cost) continue;
      table[model.id.toLowerCase()] = {
        in: model.cost.input,
        out: model.cost.output,
        cacheRead: model.cost.cache_read,
        cacheWrite: model.cost.cache_write,
      };
    }
  }
  return table;
}

/**
 * Hydrate {@link pricingOverride} from the live models.dev catalog (F-02b).
 *
 * Resolution (best-effort — any failure is swallowed so offline still works
 * and the conservative default remains the fallback):
 *   - If `COWORK_MODEL_CATALOG_URL` is set, fetch + parse THAT url directly
 *     (a models.dev-compatible catalog JSON).
 *   - Otherwise, fall back to {@link fetchCatalog} (the models.dev catalog,
 *     which itself has caching + offline fallback).
 *
 * The fetched table is MERGED onto the existing override (so a previously
 * loaded override is preserved). Call this EXPLICITLY at app startup to wire
 * the live-catalog rates into cost accounting. NOTE: importing this module
 * performs NO network call — the app startup path is responsible for calling
 * it once. The in-memory pricing memo (see {@link getPricingForModel}) is
 * cleared on every successful refresh so catalog rates take effect immediately.
 */
export async function refreshPricingFromCatalog(): Promise<void> {
  try {
    const url = typeof process !== "undefined" ? process.env?.COWORK_MODEL_CATALOG_URL : undefined;
    let table: Record<string, ModelPricing> = {};
    if (url) {
      // Custom catalog URL override (e.g. a self-hosted models.dev mirror).
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      const catalog = (await res.json()) as Catalog;
      table = convertCatalog(catalog);
    } else {
      // Default: the live models.dev catalog (with its own cache + offline fallback).
      const { fetchCatalog } = await import("./catalog");
      const catalog = await fetchCatalog();
      table = convertCatalog(catalog);
    }
    // Merge so a prior override (e.g. from a previous explicit call) survives.
    pricingOverride = { ...pricingOverride, ...table };
    // Invalidate the pricing lookup memo so the freshly-fetched catalog rates
    // take effect immediately for subsequent cost estimates.
    pricingCache.clear();
  } catch {
    // Keep the current override (or empty) if the catalog is unreachable.
  }
}

/**
 * Look up the pricing for a model by substring match (case-insensitive).
 *
 * Resolution order: (1) live catalog override, (2) a conservative expensive
 * default for unknown models. A model NOT found in the catalog is NEVER billed
 * as free — it returns {@link CONSERVATIVE_DEFAULT_PRICING} flagged
 * `uncatalogued: true` so the cost cap still trips. If the catalog has not yet
 * been loaded and no prior load is in flight, a fire-and-forget
 * {@link refreshPricingFromCatalog} is kicked off so later calls warm; the
 * current call still returns the conservative default.
 */
export function getPricingForModel(model: string): ModelPricing {
  // Return a memoized result when available (hot cost path — estimateCost runs
  // on every LLM call). The memo is invalidated on every catalog refresh.
  const cached = pricingCache.get(model);
  if (cached) return cached;

  const override = lookupPricing(pricingOverride, model);
  if (override) {
    pricingCache.set(model, override);
    return override;
  }

  // Catalog not yet populated for this model. If we've never loaded the catalog
  // and no load is currently in flight, kick off a fire-and-forget refresh so
  // subsequent calls use live rates. We still return the conservative default
  // now (cost cap still trips).
  if (Object.keys(pricingOverride).length === 0 && !pricingLoading) {
    pricingLoading = true;
    void refreshPricingFromCatalog()
      .finally(() => {
        pricingLoading = false;
      });
  }

  // Uncatalogued model — never free. Return the conservative default so the
  // cost cap still trips. Warn (once per distinct model id) so operators
  // can spot unpriced models and add them to the live catalog override for
  // accurate accounting.
  const result = { ...DEFAULT_UNKNOWN_MODEL_PRICE };
  if (!warnedUncataloguedModels.has(model)) {
    warnedUncataloguedModels.add(model);
    console.warn(
      `[pricing] No catalogued price for model "${model}". Falling back to ` +
        `DEFAULT_UNKNOWN_MODEL_PRICE ($${DEFAULT_UNKNOWN_MODEL_PRICE.in}/` +
        `$${DEFAULT_UNKNOWN_MODEL_PRICE.out} per 1M tokens, flagged uncatalogued). ` +
        `The cost cap still applies, but consider adding this model to the catalog.`
    );
  }
  pricingCache.set(model, result);
  return result;
}

/**
 * Rough cost estimate for an LLM call (USD). Returns a conservative expensive
 * rate (never $0) for unknown models so cost caps still trip.
 *
 * `reasoningTokens` (when reported by the provider, e.g. OpenAI's
 * `completion_tokens_details.reasoning_tokens`) are billed at the model's
 * `reasoning` rate (falling back to `out`). `tokensOut` is assumed to INCLUDE
 * reasoning tokens (as OpenAI reports it), so visible output = tokensOut -
 * reasoningTokens is billed at `out` and reasoningTokens at `reasoning ?? out`.
 *
 * `cachedInputTokens` (Anthropic `cache_read_input_tokens`, OpenAI
 * `cached_tokens`) are billed at the model's `cacheRead` rate (fallback: `in`).
 * `cachedWriteInputTokens` (Anthropic `cache_creation_input_tokens`) are billed
 * at the model's `cacheWrite` rate (fallback: `in`). Splitting them fixes
 * under-billing: cache writes cost MORE than reads, so billing both at the
 * read rate under-charges. Without this split, cost is mis-reported for
 * Anthropic cache-creation steps.
 *
 * The 6th parameter `cachedWriteInputTokens` is OPTIONAL (default 0) so all
 * existing 5-arg callers continue to compile and behave as before.
 */
export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  reasoningTokens: number = 0,
  cachedInputTokens: number = 0,
  cachedWriteInputTokens: number = 0
): number {
  const rate = getPricingForModel(model);

  // Cache writes are disjoint from (and typically exceed) cache reads. The
  // fresh/cached split: reads first, then writes, then fresh input.
  const cachedRead = Math.min(cachedInputTokens, tokensIn);
  const cachedWrite = Math.min(
    cachedWriteInputTokens,
    Math.max(0, tokensIn - cachedRead),
  );
  const freshInput = Math.max(0, tokensIn - cachedRead - cachedWrite);

  const visibleOut = Math.max(0, tokensOut - reasoningTokens);
  const cacheReadRate = rate.cacheRead ?? rate.in;
  const cacheWriteRate = rate.cacheWrite ?? rate.in;
  const reasoningRate = rate.reasoning ?? rate.out;

  return (
    (freshInput / 1_000_000) * rate.in +
    (cachedRead / 1_000_000) * cacheReadRate +
    (cachedWrite / 1_000_000) * cacheWriteRate +
    (visibleOut / 1_000_000) * rate.out +
    (reasoningTokens / 1_000_000) * reasoningRate
  );
}
