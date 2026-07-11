/**
 * models.dev catalog — dynamic model registry. Fetches from
 * `packages/core/src/models-dev.ts`.
 *
 * Fetches `https://models.dev/api.json` (a live JSON catalog of ALL LLM
 * providers + models + pricing), caches it in `chrome.storage.local` (5min
 * TTL), and provides lookup APIs for the extension's model picker UI.
 *
 * This is what makes the `/model` picker work: after the user connects a
 * provider (e.g. OpenAI), the catalog shows every available model with
 * pricing, context window, capabilities, and release date — searchable.
 */

/** A single model in the models.dev catalog. */
export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  description?: string;
  release_date: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  tool_call: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context: number; output: number; input?: number };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  status?: string;
}

/** A provider in the models.dev catalog. */
export interface CatalogProvider {
  id: string;
  name: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

/** The full catalog — a map of provider ID → provider info. */
export type Catalog = Record<string, CatalogProvider>;

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_KEY = "__opencowork_models_dev_catalog";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedCatalog {
  data: Catalog;
  fetchedAt: number;
}

/**
 * Fetch the models.dev catalog. Uses a 5-minute TTL cache stored in
 * `chrome.storage.local` (extension) or in-memory (demo/Node). Falls back
 * gracefully on network failure — returns the cached version if available,
 * or an empty catalog if not.
 */
export async function fetchCatalog(force = false): Promise<Catalog> {
  // Check in-memory cache first
  if (!force && memoryCache && Date.now() - memoryCacheTime < CACHE_TTL_MS) {
    return memoryCache;
  }

  // Check persistent cache (chrome.storage.local)
  if (!force && typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const cached = await chrome.storage.local.get(CACHE_KEY);
      if (cached[CACHE_KEY]) {
        const entry = cached[CACHE_KEY] as CachedCatalog;
        if (Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
          memoryCache = entry.data;
          memoryCacheTime = entry.fetchedAt;
          return entry.data;
        }
      }
    } catch { /* ignore storage errors */ }
  }

  // Fetch from models.dev
  try {
    // The `User-Agent` header is a forbidden header name in browser/SW fetch
    // (silently dropped per Fetch spec §3.4). models.dev doesn't require a UA.
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models.dev API ${res.status}`);
    const data = (await res.json()) as Catalog;
    memoryCache = data;
    memoryCacheTime = Date.now();

    // Persist to chrome.storage
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        await chrome.storage.local.set({
          [CACHE_KEY]: { data, fetchedAt: Date.now() } as CachedCatalog,
        });
      } catch { /* ignore storage quota errors */ }
    }

    return data;
  } catch {
    // Network failure — try stale cache
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        const cached = await chrome.storage.local.get(CACHE_KEY);
        if (cached[CACHE_KEY]) {
          return (cached[CACHE_KEY] as CachedCatalog).data;
        }
      } catch { /* ignore */ }
    }
    // No cache available — return empty
    return {};
  }
}

let memoryCache: Catalog | null = null;
let memoryCacheTime = 0;

/**
 * Get all models for a specific provider from the catalog.
 * Returns an array of { id, name, ... } sorted by release date (newest first).
 */
export async function getModelsForProvider(providerId: string): Promise<CatalogModel[]> {
  const catalog = await fetchCatalog();
  const provider = catalog[providerId];
  if (!provider) return [];
  return Object.values(provider.models)
    .filter((m) => m.status !== "deprecated")
    .sort((a, b) => b.release_date.localeCompare(a.release_date));
}

/**
 * Resolve the online default model for a provider from the live models.dev
 * catalog.
 *
 * Picks the NEWEST non-deprecated model for `catalogProviderId` by
 * `release_date` (descending). This is the online default — `DEFAULT_MODELS`
 * (in provider-config.ts) is only an OFFLINE fallback when the catalog is
 * unreachable. Returns `undefined` if the provider is unknown or has no usable
 * models (so callers can fall back to `DEFAULT_MODELS`).
 *
 * @param catalogProviderId The models.dev provider id (e.g. "openai",
 *                          "google", "anthropic") — NOT the extension's
 *                          provider id. Use `CATALOG_PROVIDER_ID_MAP` to map.
 */
export async function getDefaultModelForProvider(
  catalogProviderId: string,
): Promise<string | undefined> {
  try {
    const catalog = await fetchCatalog();
    const provider = catalog[catalogProviderId];
    if (!provider) return undefined;
    const models = Object.values(provider.models)
      .filter((m) => m.status !== "deprecated")
      .sort((a, b) => b.release_date.localeCompare(a.release_date));
    return models[0]?.id;
  } catch {
    // Catalog unreachable (offline, network error) — caller falls back to
    // DEFAULT_MODELS.
    return undefined;
  }
}

/**
 * Search across ALL providers + models. Returns results sorted by relevance.
 * Uses simple substring matching.
 */
export async function searchModels(query: string, limit = 50): Promise<Array<{
  providerId: string;
  providerName: string;
  model: CatalogModel;
}>> {
  const catalog = await fetchCatalog();
  const q = query.toLowerCase().trim();
  const results: Array<{ providerId: string; providerName: string; model: CatalogModel; score: number }> = [];

  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const model of Object.values(provider.models)) {
      if (model.status === "deprecated") continue;
      const modelId = model.id.toLowerCase();
      const modelName = model.name.toLowerCase();
      const providerName = provider.name.toLowerCase();

      let score = 0;
      if (modelId.includes(q)) score += 3;
      if (modelName.includes(q)) score += 2;
      if (providerName.includes(q)) score += 1;
      if (score > 0) {
        results.push({ providerId, providerName: provider.name, model, score });
      }
    }
  }

  return results
    .sort((a, b) => b.score - a.score || b.model.release_date.localeCompare(a.model.release_date))
    .slice(0, limit)
    .map(({ providerId, providerName, model }) => ({ providerId, providerName, model }));
}

/** Format a model's cost for display. */
export function formatCost(cost?: CatalogModel["cost"]): string {
  if (!cost) return "—";
  if (cost.input === 0 && cost.output === 0) return "Free";
  return `$${cost.input}/$${cost.output}/M`;
}

/** Format a model's context window for display. */
export function formatContext(limit?: CatalogModel["limit"]): string {
  if (!limit) return "—";
  const ctx = limit.context;
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

/**
 * Check whether a specific model supports vision (image inputs).
 *
 * Uses the models.dev catalog's per-model `attachment` field as the primary
 * signal. Per-model detection catches new vision models released after the
 * code was written (a per-provider hardcoded flag couldn't).
 *
 * For models NOT in the catalog (local Ollama models, custom OpenAI-compatible
 * endpoints, newly-released models not yet in models.dev), falls back to a
 * heuristic name-based check: if the model name contains "vision", "vl",
 * "llava", "moondream", "gpt-4o", "gpt-5", "claude", "gemini", "pixtral", or
 * "qwen-vl", it's assumed to support vision. This catches the common
 * vision-capable model families even when the catalog is unavailable or
 * stale.
 *
 * @param modelId The model identifier (e.g. "gpt-4o", "llama3.2-vision",
 *                "claude-sonnet-5").
 * @param providerId The provider id (e.g. "openai", "ollama"). Used to look
 *                   up the catalog entry.
 * @returns `true` if the model supports image inputs, `false` otherwise.
 */
export async function modelSupportsVision(modelId: string, providerId?: string): Promise<boolean> {
  // Primary: check the catalog's per-model `attachment` field.
  if (providerId) {
    try {
      const models = await getModelsForProvider(providerId);
      // Try exact match first, then substring match (catalog IDs sometimes
      // differ from what the user typed — e.g. "gpt-4o" vs "gpt-4o-2024-08-06").
      const exact = models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
      const candidate = exact ?? models.find((m) => m.id.toLowerCase().includes(modelId.toLowerCase()));
      if (candidate) {
        // `attachment: true` means the model accepts file/image attachments.
        if (candidate.attachment) return true;
        // Also check `modalities.input` for "image" — some providers declare
        // it there instead of via `attachment`.
        if (candidate.modalities?.input?.some((m) => m.toLowerCase().includes("image"))) return true;
        // If the catalog explicitly says `attachment: false`, trust it.
        if (candidate.attachment === false) return false;
      }
    } catch {
      // Catalog unavailable (offline, network error) — fall through to heuristic.
    }
  }

  // Fallback: heuristic name-based check for common vision-capable model
  // families. This catches local Ollama models, newly-released models not yet
  // in the catalog, and custom OpenAI-compatible endpoints.
  const name = modelId.toLowerCase();
  const VISION_KEYWORDS = [
    "vision",        // llama3.2-vision, gpt-4-vision, etc.
    "vl",            // qwen-vl, deepseek-vl (Vision-Language)
    "llava",         // Ollama llava family
    "bakllava",      // Ollama bakllava
    "moondream",     // Ollama moondream
    "minicpm",       // minicpm-o (vision-capable)
    "pixtral",       // Mistral Pixtral
    "florence",      // Microsoft Florence
    "cogvlm",        // CogVLM
    "gpt-4o",        // OpenAI GPT-4o family (all support vision)
    "gpt-5",         // OpenAI GPT-5 family (all support vision)
    "claude-3",      // Anthropic Claude 3+ (all support vision)
    "claude-4",      // Anthropic Claude 4+ (all support vision)
    "claude-sonnet", // Claude Sonnet (all support vision)
    "claude-opus",   // Claude Opus (all support vision)
    "claude-haiku",  // Claude Haiku (all support vision)
    "gemini",        // Google Gemini (all support vision)
    "grok-2-vision", // xAI Grok-2 Vision
  ];
  return VISION_KEYWORDS.some((kw) => name.includes(kw));
}

/**
 * Format a model's vision capability for display in the UI.
 * Returns "👁 Vision" if the model supports image inputs, "" otherwise.
 */
export function formatVision(attachment?: boolean): string {
  return attachment ? "👁 Vision" : "";
}

