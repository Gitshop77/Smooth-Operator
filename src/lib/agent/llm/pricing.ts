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
 * as a tested public alias (referenced by tests/pricing.test.ts) and for API
 * compatibility; no production module currently imports it.
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

/** Most recent {@link refreshPricingFromCatalog} error (null = last refresh succeeded). */
let lastPricingError: Error | null = null;

/**
 * Substring (case-insensitive) lookup over a pricing table.
 *
 * Resolution strategy to avoid order-dependent over-billing:
 *   1. An EXACT id match wins immediately (the common, correct case).
 *   2. Otherwise the LONGEST matching key wins, not the first one encountered.
 *
 * The original implementation returned the first substring match, which over-
 * bills when a shorter model id is a prefix/substring of a longer one and
 * happens to be enumerated earlier — e.g. a query for "openai/gpt-4o-mini"
 * would match the key "gpt-4o" (and be billed at gpt-4o's ~17x-higher rate)
 * whenever "gpt-4o" appeared before "gpt-4o-mini" in the table. Preferring the
 * longest key makes the most-specific catalog entry win.
 */
function lookupPricing(table: Record<string, ModelPricing>, model: string): ModelPricing | undefined {
  const m = model.toLowerCase();
  let best: { key: string; rate: ModelPricing } | undefined;
  for (const [key, rate] of Object.entries(table)) {
    if (m === key) return rate; // exact id match wins immediately
    if (m.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best?.rate;
}

/**
 * Structural validation of a parsed models.dev-shaped catalog. Mirrors the
 * (unexported) `isValidCatalog` guard in catalog.ts so the custom-URL path of
 * {@link refreshPricingFromCatalog} can reject malformed/compromised data
 * before it reaches {@link convertCatalog}. A single bad entry would otherwise
 * corrupt the pricing override table and feed non-numeric rates into
 * {@link estimateCost}, producing `NaN` (which silently defeats the cost cap).
 *
 * Accepts `unknown` (parsed JSON) rather than `Catalog` because the custom-URL
 * path receives untrusted data that has not yet been statically typed.
 */
function isValidCatalogShape(value: unknown): value is Catalog {
  if (!value || typeof value !== "object") return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const provider = entry as Record<string, unknown>;
    if (typeof provider.id !== "string" || typeof provider.name !== "string") return false;
    if (!provider.models || typeof provider.models !== "object") return false;
    for (const model of Object.values(provider.models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") return false;
      const m = model as Record<string, unknown>;
      if (typeof m.id !== "string" || typeof m.release_date !== "string") return false;
      if (m.cost !== undefined) {
        const c = m.cost as Record<string, unknown>;
        if (typeof c.input !== "number" || typeof c.output !== "number") return false;
      }
    }
  }
  return true;
}

/**
 * Convert a models.dev-shaped catalog into a lowercased pricing table.
 * Only models that declare a `cost` block contribute a rate.
 *
 * Defensive by design: the catalog is treated as `unknown` at the trust
 * boundary (e.g. an unvalidated custom `COWORK_MODEL_CATALOG_URL` response),
 * so any entry with a non-string `id` or non-numeric `cost.input/.output` is
 * skipped rather than allowed to corrupt the whole table. This keeps the
 * function safe regardless of which caller feeds it.
 */
function convertCatalog(catalog: Catalog): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  const providers = catalog as Record<string, unknown>;
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const p = provider as { models?: unknown };
    if (!p.models || typeof p.models !== "object") continue;
    for (const model of Object.values(p.models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") continue;
      const m = model as { id?: unknown; cost?: unknown };
      if (typeof m.id !== "string") continue;
      const cost = m.cost as {
        input?: unknown;
        output?: unknown;
        cache_read?: unknown;
        cache_write?: unknown;
      } | undefined;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      table[m.id.toLowerCase()] = {
        in: cost.input,
        out: cost.output,
        cacheRead: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
        cacheWrite: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
      };
    }
  }
  return table;
}

/**
 * Hydrate {@link pricingOverride} from the live models.dev catalog (F-02b).
 *
 * Resolution (best-effort — any failure leaves the current override in place
 * so offline still works and the conservative default remains the fallback):
 * the failure reason is recorded via {@link getLastPricingError} and warned in
 * non-production, so a misconfigured `COWORK_MODEL_CATALOG_URL` is visible to
 * operators instead of being silently swallowed.
 *   - If the `COWORK_MODEL_CATALOG_URL` environment variable is set, fetch +
 *     parse THAT url directly (a models.dev-compatible catalog JSON). This is
 *     the supported override knob for pointing cost accounting at a self-hosted
 *     or pinned catalog; omit it to use the live models.dev catalog.
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
      const raw = await res.json();
      // Trust-boundary guard: the custom-URL path bypasses the validation that
      // fetchCatalog() performs on the default path, so validate here. A
      // malformed/compromised response would otherwise flow into convertCatalog
      // and feed non-numeric rates to estimateCost (producing NaN that silently
      // defeats the cost cap). Drop the response rather than merge it.
      if (!isValidCatalogShape(raw)) {
        throw new Error("custom catalog failed shape validation");
      }
      table = convertCatalog(raw);
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
    lastPricingError = null;
  } catch (err) {
    // Keep the current override (or empty) if the catalog is unreachable — the
    // conservative default remains the fallback so offline still works. Record
    // the error so operators can detect a misconfigured COWORK_MODEL_CATALOG_URL
    // (an unreachable/hostile URL would otherwise silently leave every model on
    // the expensive DEFAULT_UNKNOWN_MODEL_PRICE, or worse, on NaN rates).
    lastPricingError = err instanceof Error ? err : new Error(String(err));
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.NODE_ENV !== "production"
    ) {
      console.warn("[pricing] refreshPricingFromCatalog failed:", lastPricingError.message);
    }
  }
}

/**
 * Returns the most recent {@link refreshPricingFromCatalog} error, or `null`
 * if the last refresh succeeded. Mirrors `getLastFetchError` in catalog.ts so
 * callers/UI can surface catalog-staleness or misconfiguration (e.g. a bad
 * `COWORK_MODEL_CATALOG_URL`).
 */
export function getLastPricingError(): Error | null {
  return lastPricingError;
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
 * The optional 7th parameter `completionTokens` overrides that assumption for
 * providers that report reasoning tokens OUTSIDE `tokensOut` (some reasoning-
 * model APIs do). When supplied, `completionTokens` is billed at `out` and
 * `reasoningTokens` at `reasoning ?? out`; `tokensOut` is then IGNORED for the
 * visible-output portion. Callers using this mode MUST ensure reasoning tokens
 * are NOT also counted inside `tokensOut`. When omitted (the default), the
 * historical OpenAI-style assumption (tokensOut includes reasoning) applies.
 *
 * `cachedInputTokens` (Anthropic `cache_read_input_tokens`, OpenAI
 * `cached_tokens`) are billed at the model's `cacheRead` rate (fallback: `in`).
 * `cachedWriteInputTokens` (Anthropic `cache_creation_input_tokens`) are billed
 * at the model's `cacheWrite` rate (fallback: `in`). Splitting them fixes
 * under-billing: cache writes cost MORE than reads, so billing both at the
 * read rate under-charges. Without this split, cost is mis-reported for
 * Anthropic cache-creation steps.
 *
 * The 6th parameter `cachedWriteInputTokens` and the 7th `completionTokens`
 * are OPTIONAL so all existing callers continue to compile and behave as before.
 */
export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  reasoningTokens: number = 0,
  cachedInputTokens: number = 0,
  cachedWriteInputTokens: number = 0,
  completionTokens?: number
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

  // Visible (non-reasoning) output tokens billed at `out`.
  // When the caller separately reports completionTokens (reasoning tokens live
  // OUTSIDE tokensOut), use that directly; otherwise assume the OpenAI-style
  // contract that tokensOut INCLUDES reasoning tokens.
  const visibleOut =
    completionTokens !== undefined
      ? Math.max(0, completionTokens)
      : Math.max(0, tokensOut - reasoningTokens);
  // Finite-rate guards: a non-numeric rate (e.g. from a malformed custom
  // catalog that slipped past validation) would make the whole estimate NaN,
  // which silently defeats the cost cap. Fall back to the conservative default
  // rates for any non-finite term so the cap still trips.
  const def = DEFAULT_UNKNOWN_MODEL_PRICE;
  const finite = (v: number | undefined, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
    (reasoningTokens / 1_000_000) * reasoningRate
  );
}
