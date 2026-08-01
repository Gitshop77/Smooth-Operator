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
 */
export function convertCatalog(catalog: Catalog): Record<string, ModelPricing> {
  const table: Record<string, ModelPricing> = {};
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider?.models) continue;
    for (const model of Object.values(provider.models)) {
      if (!model || typeof model.id !== "string") continue;
      const cost = model.cost;
      if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
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
      if (table[id] === undefined) table[id] = entry;
      table[`${providerId.toLowerCase()}/${id}`] = entry;
    }
  }
  return table;
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
  const ssrf = validateLlmBaseUrl(url, false);
  if (!ssrf.ok) {
    throw new Error(`refusing to fetch catalog URL: ${ssrf.reason}`);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const raw = await res.json();
  if (!isValidCatalog(raw)) {
    throw new Error("custom catalog failed shape validation");
  }
  return convertCatalog(raw);
}
