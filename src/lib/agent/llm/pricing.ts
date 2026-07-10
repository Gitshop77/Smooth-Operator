/**
 * Pricing — the single source of truth for LLM token costs.
 *
 * This module is imported by:
 *   - the orchestrator (for cost-cap enforcement via `estimateCost`)
 *   - every provider (for per-call `usage.costUsd` reporting)
 *
 * Prices are per 1M tokens (USD). Rates are BEST-EFFORT and may be stale —
 * the live models.dev catalog override (see {@link refreshPricingFromCatalog})
 * is the source of truth. Date-stamped: 2026-07 (best-effort snapshot; not
 * guaranteed to match current provider pricing). Models with reasoning-token
 * pricing include a `reasoning` field; reasoning tokens are billed at that
 * rate (falling back to `out`).
 *
 * IMPORTANT: ordering matters for the substring match in {@link getPricingForModel}.
 * More-specific keys MUST be listed BEFORE less-specific ones:
 *   gpt-4o-mini before gpt-4o
 *   o3-mini before o3, o1-mini/o1-pro before o1
 *   gemini-2.0-flash-thinking-exp before gemini-2.0-flash
 */

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
   * uncatalogued model (the model was NOT found in the static table or the
   * live catalog override). Consumers may use this to ensure cost caps still
   * trip for unknown models — an uncatalogued model is NEVER billed as free.
   */
  readonly uncatalogued?: boolean;
}

/**
 * The canonical pricing table. When adding a model, also update the
 * models.dev catalog fetcher (which can override these at runtime if the
 * catalog has fresher data).
 *
 * Date-stamped: 2026-07. Rates are best-effort; the live models.dev catalog
 * (see {@link refreshPricingFromCatalog}) is the authoritative source and may
 * override any entry here at runtime.
 */
export const PRICING_PER_MTOK: Record<string, ModelPricing> = {
  // OpenAI — more-specific keys first (mini/pro variants before base models).
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4-turbo": { in: 10, out: 30 },
  "o3-mini": { in: 1.1, out: 4.4, reasoning: 4.4 },
  "o3": { in: 2, out: 8, reasoning: 8 },
  "o1-mini": { in: 3, out: 12, reasoning: 12 },
  "o1-pro": { in: 150, out: 600, reasoning: 600 },
  "o1": { in: 15, out: 60, reasoning: 60 },
  // Anthropic — short aliases catch date-tagged variants (e.g.
  // claude-3-5-sonnet-20241022, claude-3-opus-20240229) via substring match.
  "claude-3-7-sonnet": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-haiku": { in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-opus": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // Google Gemini — thinking-exp (free during experimental period) before flash.
  // Includes cacheRead (cached content billed at 25% of input) + reasoning
  // (thinking tokens billed at output rate for 2.5 Flash/Pro Thinking).
  "gemini-2.5-pro": { in: 1.25, out: 10, cacheRead: 0.31, reasoning: 10 },
  "gemini-2.5-flash-lite": { in: 0.075, out: 0.3, cacheRead: 0.01875 },
  "gemini-2.5-flash": { in: 0.15, out: 0.6, cacheRead: 0.0375, reasoning: 0.6 },
  "gemini-2.0-flash-thinking-exp": { in: 0, out: 0 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4, cacheRead: 0.025 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3, cacheRead: 0.01875 },
  "gemini-1.5-pro": { in: 1.25, out: 5, cacheRead: 0.31 },
  // DeepSeek
  "deepseek-reasoner": { in: 0.55, out: 2.19, reasoning: 2.19 },
  "deepseek-chat": { in: 0.27, out: 1.1 },
  // Mistral (La Plateforme pricing; "mistral-large-latest" resolves to the
  // current large model — the substring match catches the versioned IDs).
  "mistral-large": { in: 2, out: 6 },
  "mistral-small": { in: 0.2, out: 0.6 },
  // xAI
  "grok-2-vision": { in: 2, out: 10 },
  "grok-2": { in: 2, out: 10 },
  // Qwen (DashScope / Together AI pricing)
  "qwen-2.5-coder-32b-instruct": { in: 0.5, out: 0.5 },
  "qwen-2.5-72b-instruct": { in: 0.88, out: 0.88 },
};

/**
 * Conservative pricing used for models NOT found in the static table or the
 * live catalog override. A missing model must NEVER be billed as free — doing
 * so defeats the cost cap and allows unbounded spend. We therefore default
 * unknown models to a clearly-expensive rate (in: $10 / out: $30 per 1M tokens,
 * roughly GPT-4-class pricing) and flag them `uncatalogued: true` so callers
 * that want to be stricter can block instead of bill.
 */
export const CONSERVATIVE_DEFAULT_PRICING: ModelPricing = {
  in: 10,
  out: 30,
  uncatalogued: true,
};

/**
 * Live catalog override table (populated by {@link refreshPricingFromCatalog}),
 * keyed by lowercased model id. Takes precedence over {@link PRICING_PER_MTOK}
 * when present, so fresher models.dev catalog rates win over the static table.
 */
let pricingOverride: Record<string, ModelPricing> = {};

/** Substring (case-insensitive) lookup over a pricing table. */
function lookupPricing(table: Record<string, ModelPricing>, model: string): ModelPricing | undefined {
  const m = model.toLowerCase();
  for (const [key, rate] of Object.entries(table)) {
    if (m.includes(key)) return rate;
  }
  return undefined;
}

/**
 * Hydrate {@link pricingOverride} from the live models.dev catalog
 * (`fetchCatalog`). Best-effort: network/storage failures are swallowed and
 * the existing override (if any) is kept. Call this at app startup to wire the
 * documented live-catalog override into cost accounting.
 */
export async function refreshPricingFromCatalog(): Promise<void> {
  try {
    const { fetchCatalog } = await import("./catalog");
    const catalog = await fetchCatalog();
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
    pricingOverride = table;
  } catch {
    // Keep the current override (or empty) if the catalog is unreachable.
  }
}

/**
 * Look up the pricing for a model by substring match (case-insensitive).
 *
 * Resolution order: (1) live catalog override, (2) the static table, (3) a
 * conservative expensive default for unknown models. A model NOT found in the
 * table or catalog is NEVER billed as free — it returns
 * {@link CONSERVATIVE_DEFAULT_PRICING} flagged `uncatalogued: true` so the
 * cost cap still trips. Ordering of the static table still matters (more-
 * specific keys first); the override is matched first so fresher catalog
 * rates win.
 */
export function getPricingForModel(model: string): ModelPricing {
  const override = lookupPricing(pricingOverride, model);
  if (override) return override;
  const staticRate = lookupPricing(PRICING_PER_MTOK, model);
  if (staticRate) return staticRate;
  // Uncatalogued model — never free. Return the conservative default so the
  // cost cap still trips. (The live catalog may be hydrated at startup via
  // refreshPricingFromCatalog to supply a more accurate rate later.)
  return { ...CONSERVATIVE_DEFAULT_PRICING };
}

/**
 * Rough cost estimate for an LLM call (USD). Returns a conservative expensive
 * rate (never $0) for unknown models so cost caps still trip.
 *
 * `reasoningTokens` (when reported by the provider, e.g. OpenAI's
 * `completion_tokens_details.reasoning_tokens`) are billed at the model's
 * `reasoning` rate. `tokensOut` is assumed to INCLUDE reasoning tokens
 * (as OpenAI reports it), so visible output = tokensOut - reasoningTokens
 * is billed at `out` and reasoningTokens at `reasoning ?? out`.
 *
 * `cachedInputTokens` (when reported — Anthropic's cache_read + cache_creation,
 * OpenAI's prompt_tokens_details.cached_tokens) are billed at the model's
 * `cacheRead` rate (fallback: `in`). Without this, cost is over-reported
 * because ALL input is billed at the full `in` rate even when a portion
 * was served from the provider's prompt cache at a 50-90% discount.
 */
export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
  reasoningTokens: number = 0,
  cachedInputTokens: number = 0
): number {
  const rate = getPricingForModel(model);
  const reasoning = reasoningTokens > 0 ? reasoningTokens : 0;
  const cached = cachedInputTokens > 0 ? Math.min(cachedInputTokens, tokensIn) : 0;
  const freshInput = Math.max(0, tokensIn - cached);
  const visibleOut = Math.max(0, tokensOut - reasoning);
  const reasoningRate = rate.reasoning ?? rate.out;
  const cacheReadRate = rate.cacheRead ?? rate.in;
  return (
    (freshInput / 1_000_000) * rate.in +
    (cached / 1_000_000) * cacheReadRate +
    (visibleOut / 1_000_000) * rate.out +
    (reasoning / 1_000_000) * reasoningRate
  );
}
