import type { Catalog } from "./catalog";
import { isValidCatalog } from "./catalog";
import { validateLlmBaseUrl, resolveAndValidateLlmBaseUrl } from "./route/ssrf";

/** A context-tier pricing block (models.dev `CostTier` shape, verbatim). */
export interface CostTier {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly tier: { type: "context"; size: number };
}

/** The legacy >200k-context pricing block (`context_over_200k`). */
export interface CostBlock {
  readonly input: number;
  readonly output: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
}

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
  /** Context-tier rates — the highest tier whose `size` is below the prompt's
   * context-token count applies (tier selection mirrors opencode's session cost). */
  readonly tiers?: CostTier[];
  /** Rates applied when the prompt exceeds 200k context tokens and no tier matches. */
  readonly contextOver200k?: CostBlock;
  readonly uncatalogued?: boolean;
}

/** Clamp a (possibly malformed) token count to a finite, non-negative integer. */
export function tokenCount(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Fall back to a conservative rate when a pricing term is non-finite. */
export function finite(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Substring (case-insensitive) lookup over a pricing table.
 *
 * Resolution strategy:
 * 1. An EXACT id match wins immediately.
 * 2. Otherwise the LONGEST matching key wins.
 */
export function lookupPricing(
  table: Record<string, ModelPricing>,
  model: string,
  providerId?: string,
): ModelPricing | undefined {
  const m = model.toLowerCase();
  const prefix = providerId ? providerId.toLowerCase() : undefined;

  return lookupByProviderPrefix(table, m, prefix)
    ?? lookupExact(table, m)
    ?? lookupBySubstring(table, m);
}

/** Try a provider-prefixed key (e.g. `openai/gpt-4o`). */
function lookupByProviderPrefix(
  table: Record<string, ModelPricing>,
  model: string,
  prefix: string | undefined,
): ModelPricing | undefined {
  if (!prefix) return undefined;
  return table[`${prefix}/${model}`];
}

/** Try an exact bare id match. */
function lookupExact(
  table: Record<string, ModelPricing>,
  model: string,
): ModelPricing | undefined {
  return table[model];
}

/** Find the longest matching key via substring match. */
function lookupBySubstring(
  table: Record<string, ModelPricing>,
  model: string,
): ModelPricing | undefined {
  let best: { key: string; rate: ModelPricing } | undefined;
  for (const [key, rate] of Object.entries(table)) {
    if (!model.includes(key)) continue;
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
 * Zero rates ARE honored (a model may legitimately be repriced to free): the
 * validation layer (`isValidCatalog`) permits them, so skipping them here
 * would silently drop ~575 bundled models to DEFAULT_UNKNOWN_MODEL_PRICE
 * ($10/$30 per 1M) and make a custom-catalog "reprice to free" never take
 * effect. Only negative rates are rejected (they would subtract from spend).
 */
export function convertCatalog(catalog: Catalog): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider?.models) continue;
    for (const model of Object.values(provider.models)) {
      if (!model || typeof model.id !== "string") continue;
      const cost = model.cost;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      if (cost.input < 0 || cost.output < 0) continue;
      if (cost.cache_read !== undefined && (typeof cost.cache_read !== "number" || cost.cache_read < 0)) continue;
      if (cost.cache_write !== undefined && (typeof cost.cache_write !== "number" || cost.cache_write < 0)) continue;
      if (cost.tiers !== undefined) {
        if (!Array.isArray(cost.tiers)) continue;
        let tiersValid = true;
        for (const t of cost.tiers) {
          if (
            !t || typeof t !== "object" ||
            typeof t.input !== "number" || t.input < 0 ||
            typeof t.output !== "number" || t.output < 0 ||
            (t.cache_read !== undefined && (typeof t.cache_read !== "number" || t.cache_read < 0)) ||
            (t.cache_write !== undefined && (typeof t.cache_write !== "number" || t.cache_write < 0)) ||
            !t.tier || typeof t.tier.size !== "number" || t.tier.size < 0
          ) {
            // A malformed tier poisons the whole model — never bill tier rates
            // from partially-valid data (mirrors the flat-field rejection above).
            tiersValid = false;
            break;
          }
        }
        if (!tiersValid) continue;
      }
      if (cost.context_over_200k !== undefined) {
        const b = cost.context_over_200k;
        if (
          !b || typeof b !== "object" ||
          typeof b.input !== "number" || b.input < 0 ||
          typeof b.output !== "number" || b.output < 0 ||
          (b.cache_read !== undefined && (typeof b.cache_read !== "number" || b.cache_read < 0)) ||
          (b.cache_write !== undefined && (typeof b.cache_write !== "number" || b.cache_write < 0))
        ) continue;
      }
      const id = model.id.toLowerCase();
      const entry: ModelPricing = {
        in: cost.input,
        out: cost.output,
        reasoning: typeof cost.reasoning === "number" ? cost.reasoning : undefined,
        cacheRead: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
        cacheWrite: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
        tiers:
          cost.tiers !== undefined
            ? cost.tiers
                .filter((t) => t.tier.type === "context")
                .map((t) => ({
                  input: t.input,
                  output: t.output,
                  cache_read: t.cache_read,
                  cache_write: t.cache_write,
                  tier: { type: "context" as const, size: t.tier.size },
                }))
            : undefined,
        contextOver200k:
          cost.context_over_200k !== undefined
            ? {
                input: cost.context_over_200k.input,
                output: cost.context_over_200k.output,
                cache_read: cost.context_over_200k.cache_read,
                cache_write: cost.context_over_200k.cache_write,
              }
            : undefined,
      };
      if (table[id] === undefined) table[id] = entry;
      table[`${providerId.toLowerCase()}/${id}`] = entry;
    }
  }
  return table;
}

/**
 * Select the pricing block for a given context-token usage, mirroring
 * opencode's session cost: the highest context tier whose `size` is below
 * `contextTokens`, else the over-200k block when the context exceeds 200k,
 * else the base rate. Returns the base rate when no tiers are declared.
 */
export function selectPricingRate(rate: ModelPricing, contextTokens: number): ModelPricing {
  if (rate.tiers && rate.tiers.length > 0) {
    const tiers = rate.tiers
      .filter((t) => t.tier.type === "context" && contextTokens > t.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size);
    if (tiers.length > 0) {
      const t = tiers[0];
      return {
        in: t.input,
        out: t.output,
        cacheRead: t.cache_read,
        cacheWrite: t.cache_write,
      };
    }
  }
  if (rate.contextOver200k && contextTokens > 200_000) {
    const b = rate.contextOver200k;
    return {
      in: b.input,
      out: b.output,
      cacheRead: b.cache_read,
      cacheWrite: b.cache_write,
    };
  }
  return rate;
}

/**
 * Fetch with bounded retry/backoff for transient failures.
 */
export async function fetchWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Fetch and validate a custom catalog from a user-specified URL.
 */
export async function fetchCustomCatalog(url: string): Promise<Record<string, ModelPricing>> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`refusing to fetch non-HTTP catalog URL: ${parsedUrl.protocol}`);
  }
  // Strict SYNCHRONOUS posture first (unchanged from before): loopback /
  // private / link-local / metadata hosts are rejected even for a catalog URL,
  // preserving the exact pre-existing allowlist.
  const ssrf = validateLlmBaseUrl(url, false);
  if (!ssrf.ok) {
    throw new Error(`refusing to fetch catalog URL: ${ssrf.reason}`);
  }
  // Best-effort DNS validation (DNS-rebinding defense-in-depth): the catalog
  // URL is operator-configured, so `"user-configured"` provenance applies —
  // when a resolver IS available (Dev-channel builds that declare the "dns"
  // permission) a hostname resolving to an internal/metadata address is
  // rejected before any fetch; when no resolver is available (packaged stable
  // builds have no `dns` permission and no Node fallback) the guard degrades
  // to the sync check above + a warning, so custom catalogs keep working. The
  // sync check runs FIRST and is never weakened by this step.
  const dns = await resolveAndValidateLlmBaseUrl(url, false, "user-configured");
  if (!dns.ok) {
    throw new Error(`refusing to fetch catalog URL: ${dns.reason}`);
  }
  // Hardening mirroring the route transport: never follow redirects (a 3xx
  // could bounce the catalog request — and any ambient context — to an
  // attacker origin), never send ambient credentials/cookies, never reuse a
  // cached response, and attach no Referer.
  const res = await fetch(url, {
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    referrer: "",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const raw = await res.json();
  if (!isValidCatalog(raw)) {
    throw new Error("custom catalog failed shape validation");
  }
  return convertCatalog(raw);
}
