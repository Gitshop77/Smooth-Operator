/**
 * Pricing — the single source of truth for LLM token costs.
 *
 * This module is imported by:
 * - the orchestrator (for cost-cap enforcement via `estimateCost`)
 * - every provider (for per-call `usage.costUsd` reporting)
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
 * back to `out`.
 */

import type { Catalog } from "./catalog";
import { isValidCatalog } from "./catalog";
import { validateLlmBaseUrl } from "./route/ssrf";

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

/**
 * Public alias for {@link DEFAULT_UNKNOWN_MODEL_PRICE}, kept purely as a tested
 * API-compatibility name (referenced by tests/pricing.test.ts). No production
 * module currently imports this alias — they use {@link DEFAULT_UNKNOWN_MODEL_PRICE}
 * directly.
 */
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
 * Non-mutating read of {@link lastPricingError} — the most recent
 * {@link refreshPricingFromCatalog} failure, or `null` when the last refresh
 * succeeded. Exported so callers (e.g. the Options UI pricing-health line) can
 * surface the failure reason WITHOUT resetting any module state. This is purely
 * a getter: it never clears the override, memo, warned-set, or error.
 */
export function getLastPricingError(): Error | null {
  return lastPricingError;
}

/** Timestamp (ms) of the last fire-and-forget refresh trigger, used for cooldown. */
let lastRefreshAttempt = 0;

/**
 * Minimum gap between fire-and-forget refresh triggers. After a failed refresh
 * `pricingOverride` stays empty and `pricingLoading` is reset to `false`, so a
 * naive trigger would spawn a new background `fetch` on *every* subsequent
 * `estimateCost` (one per LLM call). The cooldown bounds that to at most one
 * trigger per window, preventing network/connection exhaustion when the catalog
 * host is unreachable .
 */
const REFRESH_COOLDOWN_MS = 30_000;

/** Bounds on the in-memory pricing memo / warned-model set (long-lived SW, F-15). */
const MAX_PRICING_CACHE = 256;
const MAX_WARNED_MODELS = 128;

/**
 * Drop the oldest pricing-memo entry (insertion-ordered) so the cache can't
 * grow without bound in a long-lived service worker.
 */
function evictPricingCache(): void {
  if (pricingCache.size >= MAX_PRICING_CACHE) {
    const oldest = pricingCache.keys().next().value;
    if (oldest !== undefined) pricingCache.delete(oldest);
  }
}

/** Clear the warned-model set wholesale (bounded spam control) once it hits its cap. */
function maybeClearWarnedModels(): void {
  if (warnedUncataloguedModels.size >= MAX_WARNED_MODELS) {
    warnedUncataloguedModels.clear();
  }
}

/**
 * Substring (case-insensitive) lookup over a pricing table.
 *
 * Resolution strategy to avoid order-dependent over-billing:
 * 1. An EXACT id match wins immediately (the common, correct case).
 * 2. Otherwise the LONGEST matching key wins, not the first one encountered.
 *
 * The original implementation returned the first substring match, which over-
 * bills when a shorter model id is a prefix/substring of a longer one and
 * happens to be enumerated earlier — e.g. a query for "openai/gpt-4o-mini"
 * would match the key "gpt-4o" (and be billed at gpt-4o's ~17x-higher rate)
 * whenever "gpt-4o" appeared before "gpt-4o-mini" in the table. Preferring the
 * longest key makes the most-specific catalog entry win.
 */
function lookupPricing(
  table: Record<string, ModelPricing>,
  model: string,
  providerId?: string,
): ModelPricing | undefined {
  const m = model.toLowerCase();
  const prefix = providerId ? providerId.toLowerCase() : undefined;
 // 1. When the caller knows its provider, a provider-prefixed key
 // (`openai/gpt-4o`) disambiguates same-named models across providers and
 // wins over any bare-id entry (which may belong to a different provider).
  if (prefix && table[`${prefix}/${m}`]) return table[`${prefix}/${m}`];
 // 2. An EXACT bare id match wins immediately (the common, correct case).
  if (table[m]) return table[m];
 // 3. Otherwise the LONGEST matching key wins, preferring the caller's provider
 // prefix so a same-named model from a different provider isn't billed at the
 // wrong rate. The original implementation returned the first substring match,
 // which over-bills when a shorter model id is a prefix of a longer one and
 // happens to be enumerated earlier.
  let best: { key: string; rate: ModelPricing } | undefined;
  for (const [key, rate] of Object.entries(table)) {
    if (!m.includes(key)) continue;
    // The longest matching key wins (most-specific catalog entry). The
    // provider-prefixed keys cannot match `m.includes(key)` here because `m`
    // is a bare model id (no slash), so a provider-preference branch would be
    // dead code — drop it and pick purely by descending key length.
    if (!best || key.length > best.key.length) {
      best = { key, rate };
    }
  }
  return best?.rate;
}

/**
 * Convert a models.dev-shaped catalog into a lowercased pricing table.
 * Only models that declare a `cost` block contribute a rate.
 *
 * Both call sites (`refreshPricingFromCatalog`) run `isValidCatalog` first, so
 * `cost` is already shape/range-validated. This function additionally defends
 * itself: any entry with a non-string `id`, non-numeric `cost.input/.output`,
 * or a non-positive rate is skipped rather than allowed to corrupt the whole
 * table (a 0 rate would make `estimateCost` multiply token counts by zero and
 * never accumulate spend, silently defeating the cost cap; negative rates would
 * subtract from it — see `estimateCost`).
 *
 * Each model is keyed by its bare id (legacy behavior) AND by a
 * provider-prefixed id (`<providerId>/<modelId>`) so a caller that knows its
 * provider can disambiguate same-named models across providers (see
 * `lookupPricing`).
 */
function convertCatalog(catalog: Catalog): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider?.models) continue;
    for (const model of Object.values(provider.models)) {
      if (!model || typeof model.id !== "string") continue;
      const cost = model.cost;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
 // Reject non-positive rates (0 OR negative). `isValidCatalog` permits 0
 // so the picker UI can still display legitimately-free models, but a 0
 // input/output rate here would make `estimateCost` multiply token counts
 // by zero and never accumulate spend — silently defeating the cost cap.
 // Skipping the entry treats a non-positive rate as "uncatalogued", so
 // `getPricingForModel` falls back to DEFAULT_UNKNOWN_MODEL_PRICE
 // (expensive) and the cap still trips. We keep this check even though
 // `isValidCatalog` already ran, so the function stays safe if a future
 // caller feeds it unvalidated data.
      if (cost.input <= 0 || cost.output <= 0) continue;
      if (cost.cache_read !== undefined && (typeof cost.cache_read !== "number" || cost.cache_read < 0)) continue;
      if (cost.cache_write !== undefined && (typeof cost.cache_write !== "number" || cost.cache_write < 0)) continue;
      const id = model.id.toLowerCase();
      const entry: ModelPricing = {
        in: cost.input,
        out: cost.output,
        reasoning: typeof cost.reasoning === "number" ? cost.reasoning : undefined,
        cacheRead: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
        cacheWrite: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
      };
 // First-writer-wins for the BARE id: a shared bare id (e.g.
 // `gemini-2.5-pro`) is declared by many providers (aggregators, mirrors,
 // first-party). Under the previous last-writer-wins behavior the LAST
 // provider in iteration order clobbered the bare-id entry, so a mis-billing
 // aggregator (often charging more) won silently. Pinning the bare id on the
 // FIRST writer makes resolution deterministic and stable across catalog
 // loads — and because the bundled catalog's first provider to declare a
 // given bare id is typically a faithful pass-through (e.g. 302ai reprices
 // gemini-2.5-pro at Google's official 1.25/10), the bare-id fallback stays
 // correct for same-named models across providers.
 //
 // The provider-scoped key is ALWAYS set so a caller that knows its provider
 // (e.g. provider-bridge passing config.providerId) disambiguates via
 // lookupPricing step 1 (`<providerId>/<modelId>`), which wins over the
 // bare-id entry. This key must stay in sync with that lookup prefix.
      if (table[id] === undefined) table[id] = entry; // bare id: first writer wins (deterministic)
      table[`${providerId.toLowerCase()}/${id}`] = entry; // provider-scoped key always set
    }
  }
  return table;
}

/**
 * Hydrate {@link pricingOverride} from the live models.dev catalog (F-02b).
 *
 * Resolution (best-effort — any failure leaves the current override in place
 * so offline still works and the conservative default remains the fallback):
 * the failure reason is recorded (see {@link lastPricingError}) and warned in
 * non-production, so a misconfigured `COWORK_MODEL_CATALOG_URL` is visible to
 * operators instead of being silently swallowed.
 * - If the `COWORK_MODEL_CATALOG_URL` environment variable is set, fetch +
 * parse THAT url directly (a models.dev-compatible catalog JSON). This is
 * the supported override knob for pointing cost accounting at a self-hosted
 * or pinned catalog; omit it to use the live models.dev catalog.
 * - Otherwise, fall back to {@link fetchCatalog} (the models.dev catalog,
 * which itself has caching + offline fallback).
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
 //
 // TRUST ASSUMPTION: whoever controls `COWORK_MODEL_CATALOG_URL` (an
 // operator-injected env var, by design) controls the rates that feed
 // cost-cap enforcement. This is an intentional operator knob — a
 // SELF-HOSTED MIRROR on a PUBLICLY-REACHABLE, non-restricted host
 // legitimately reprices models. The mirror URL MUST still pass the SSRF
 // guard below: loopback / RFC1918 / link-local / CGNAT / unspecified /
 // .internal targets are correctly REJECTED (not a supported topology), so
 // only a genuinely public mirror is fetched. We still
 // reject non-positive rates (0 AND negative) in `convertCatalog`, which
 // both this path and the default path flow through: a 0 rate would make
 // `estimateCost` multiply token counts by zero and never trip the cap, a
 // negative rate would subtract from spend — and no legitimate repricing
 // produces either. A non-positive entry is simply dropped and falls back
 // to DEFAULT_UNKNOWN_MODEL_PRICE (expensive) so the cap holds regardless
 // of the mirror's contents. Strictly-negative rates are additionally
 // caught up-front by `isValidCatalog` below (its validation is shared
 // with the default path); failures surface via `lastPricingError` + a
 // non-production console.warn so misconfiguration is visible.
 // SSRF guard: route the custom catalog URL through the shared SSRF guard so
 // it can never reach a cloud-metadata, link-local, unspecified, CGNAT,
 // loopback, RFC1918, or ULA target. The env var is operator-controlled, but a
 // value such as `file:///etc/passwd`, the cloud-metadata endpoint
 // (`http://169.254.169.254/`), `http://127.0.0.1:port/`, or a `.internal`
 // hostname would otherwise be fetched (the response is rejected by
 // isValidCatalog, but the outbound request still fires). The protocol
 // pre-filter stays as a fast check; the shared guard is the authoritative
 // egress check that every other outbound path in the codebase uses.
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`refusing to fetch non-HTTP catalog URL: ${parsedUrl.protocol}`);
      }
      const ssrf = validateLlmBaseUrl(url, false);
      if (!ssrf.ok) {
        throw new Error(`refusing to fetch catalog URL: ${ssrf.reason}`);
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      const raw = await res.json();
 // Trust-boundary guard: the custom-URL path bypasses the validation that
 // fetchCatalog() performs on the default path, so validate the shape here
 // using the SAME guard catalog.ts uses (single shared rule, no drift). A
 // malformed/compromised response would otherwise flow into convertCatalog
 // and feed non-numeric rates to estimateCost (producing NaN that silently
 // defeats the cost cap). Drop the response rather than merge it.
      if (!isValidCatalog(raw)) {
        throw new Error("custom catalog failed shape validation");
      }
      table = convertCatalog(raw);
    } else {
 // Default: the live models.dev catalog (with its own cache + offline fallback).
      const { fetchCatalog } = await import("./catalog");
 // Pass `force = true` so we bypass catalog.ts's module-level memoryCache
 // and always re-read the LIVE catalog on refresh. refreshPricingFromCatalog
 // is the deliberate hydration entry point (called at app startup / on an
 // explicit pricing refresh), so it must reflect the current catalog rather
 // than a stale in-memory snapshot from a previous fetch. The cost here is
 // one extra network fetch at refresh time; the graceful offline/stale-cache
 // fallback inside fetchCatalog still applies if the network is down.
      // R2 §6: bounded retry/backoff for transient failures. A momentary network
      // blip (briefly offline, models.dev momentarily unavailable) must NOT
      // permanently strand pricing on the conservative default. Retry the LIVE
      // fetch up to 2 extra times with a fixed 500ms backoff before giving up.
      // On success the merge/clear below runs byte-for-byte as before; only the
      // failure path changes (adding retries before the existing catch records
      // `lastPricingError` + warns).
      let catalog: Catalog | undefined;
      let ok = false;
      let lastFetchErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          catalog = await fetchCatalog(true);
          ok = true;
          break;
        } catch (err) {
          lastFetchErr = err;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!ok || !catalog) {
        // Re-throw so the outer catch records lastPricingError + warns exactly as
        // before (final-failure behavior is unchanged).
        throw lastFetchErr instanceof Error ? lastFetchErr : new Error(String(lastFetchErr));
      }
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
    console.warn("[pricing] refreshPricingFromCatalog failed:", lastPricingError.message);
  }
}

/**
 * Store a result in the pricing memo, evicting the oldest entry when the memo
 * exceeds {@link MAX_PRICING_CACHE} so it can't grow without bound in a
 * long-lived service worker .
 */
function setPricingCache(key: string, value: ModelPricing): void {
  evictPricingCache();
  pricingCache.set(key, value);
}

/**
 * Look up the pricing for a model by substring match (case-insensitive).
 *
 * Resolution order: (1) live catalog override, (2) a conservative expensive
 * default for unknown models. A model NOT found in the catalog is NEVER billed
 * free — it returns {@link CONSERVATIVE_DEFAULT_PRICING} flagged
 * `uncatalogued: true` so the cost cap still trips. If the catalog has not yet
 * been loaded and no prior load is in flight (and we're outside the failure
 * cooldown), a fire-and-forget {@link refreshPricingFromCatalog} is kicked off
 * so later calls warm; the current call still returns the conservative default.
 */
export function getPricingForModel(model: string, providerId?: string): ModelPricing {
 // Return a memoized result when available (hot cost path — estimateCost runs
 // on every LLM call). The memo is invalidated on every catalog refresh. The
 // cache key incorporates the provider when known so same-named models from
 // different providers don't collide.
  const cacheKey = providerId ? `${providerId}::${model}` : model;
  const cached = pricingCache.get(cacheKey);
  if (cached) return cached;

  const override = lookupPricing(pricingOverride, model, providerId);
  if (override) {
    setPricingCache(cacheKey, override);
    return override;
  }

 // Catalog not yet populated for this model. If we've never loaded the catalog
 // and no load is currently in flight (and we're outside the failure cooldown),
 // kick off a fire-and-forget refresh so subsequent calls use live rates. We
 // still return the conservative default now (cost cap still trips).
  if (
    Object.keys(pricingOverride).length === 0 &&
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

 // Uncatalogued model — never free. Return the conservative default so the
 // cost cap still trips. Warn (once per distinct model id) so operators
 // can spot unpriced models and add them to the live catalog override for
 // accurate accounting. The warned-set is bounded so a very long run against
 // many distinct unpriced models can't grow it without limit.
  const result = { ...DEFAULT_UNKNOWN_MODEL_PRICE };
  if (!warnedUncataloguedModels.has(model)) {
    maybeClearWarnedModels();
    warnedUncataloguedModels.add(model);
    console.warn(
      `[pricing] No catalogued price for model "${model}". Falling back to ` +
        `DEFAULT_UNKNOWN_MODEL_PRICE ($${DEFAULT_UNKNOWN_MODEL_PRICE.in}/` +
        `$${DEFAULT_UNKNOWN_MODEL_PRICE.out} per 1M tokens, flagged uncatalogued). ` +
        `The cost cap still applies, but consider adding this model to the catalog.`
    );
  }
  setPricingCache(cacheKey, result);
  return result;
}

/**
 * Test-only resetter: clears all mutable pricing module state so pricing
 * tests are isolated from one another (stubbed catalog loads, the in-memory
 * memo, the warned-model set, and refresh state). Exported ONLY for tests — do
 * not call this from production code. Production relies on the module-singleton
 * state surviving the service-worker lifetime; resetting it outside tests would
 * wipe a freshly loaded live catalog.
 */
export function __resetPricingForTests(): void {
  pricingOverride = {};
  pricingCache.clear();
  warnedUncataloguedModels.clear();
  pricingLoading = false;
  lastRefreshAttempt = 0;
  lastPricingError = null;
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
 * An 8th optional `providerId` argument, when supplied, lets the pricing lookup
 * prefer that provider's rate for same-named models that appear under multiple
 * providers (disambiguating cost-cap accounting across providers).
 */
/** Clamp a (possibly malformed) token count to a finite, non-negative integer. */
function tokenCount(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Fall back to a conservative rate when a pricing term is non-finite. */
function finite(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  reasoningTokens: number = 0,
  cachedInputTokens: number = 0,
  cachedWriteInputTokens: number = 0,
  completionTokens?: number,
  providerId?: string
): number {
  const rate = getPricingForModel(model, providerId);

 // Token-count guards: malformed usage (NaN/Infinity/negative token counts)
 // would otherwise flow straight into the summation and silently defeat the
 // cost cap — a NaN count makes the whole estimate NaN (cap can't trip), and a
 // negative count subtracts from accumulated spend. Clamp every count to a
 // finite, non-negative integer BEFORE any arithmetic. `completionTokens` is
 // sanitized only when supplied so the "omitted" branch below still applies.
  tokensIn = tokenCount(tokensIn);
  tokensOut = tokenCount(tokensOut);
  reasoningTokens = tokenCount(reasoningTokens);
  cachedInputTokens = tokenCount(cachedInputTokens);
  cachedWriteInputTokens = tokenCount(cachedWriteInputTokens);
  if (completionTokens !== undefined) completionTokens = tokenCount(completionTokens);

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
