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

/** In-memory cache of the most recently fetched catalog. */
let memoryCache: Catalog | null = null;
/** Timestamp (ms) of the last `memoryCache` population. */
let memoryCacheTime = 0;
/** In-flight fetch promise, memoized to dedupe concurrent callers. */
let inflight: Promise<Catalog> | null = null;

/**
 * Heuristic vision-capable model-name patterns (fallback used only when a
 * model is NOT in the catalog). Hoisted to module scope so it is allocated
 * once per process, not on every `modelSupportsVision` call.
 *
 * Word-boundary (`\b`) matching replaces the previous `name.includes(kw)`
 * scan: a bare `includes("vl")` matched any id containing those two letters
 * (e.g. a non-vision model whose name happened to include "vl"), feeding the
 * wrong screenshot-gating path in `extractStateForRun`. Anchoring each token
 * to a word boundary keeps the heuristic precise while still catching the
 * common vision families (qwen-vl, deepseek-vl, gpt-4o, claude-3, gemini, …).
 */
const VISION_PATTERNS: RegExp[] = [
  /\bvision\b/i,
  /\bvl\b/i,
  /\bllava\b/i,
  /\bbakllava\b/i,
  /\bmoondream\b/i,
  /\bminicpm\b/i,
  /\bpixtral\b/i,
  /\bflorence\b/i,
  /\bcogvlm\b/i,
  /\bgpt-4o\b/i,
  /\bgpt-5\b/i,
  /\bclaude-3\b/i,
  /\bclaude-4\b/i,
  /\bclaude-sonnet\b/i,
  /\bclaude-opus\b/i,
  /\bclaude-haiku\b/i,
  /\bgemini\b/i,
  /\bgrok-2-vision\b/i,
];

interface CachedCatalog {
  data: Catalog;
  fetchedAt: number;
}

/**
 * Minimal structural validation of a parsed models.dev catalog. Rejects
 * obviously-wrong shapes (non-object, missing provider entries, `models`
 * not a record, non-numeric or negative cost fields, or a non-string `name`)
 * so malformed/compromised data can't flow into the model picker. A negative
 * rate is rejected because it would feed `estimateCost` (pricing.ts) and
 * subtract from accumulated spend, silently defeating the cost cap; zero is
 * permitted so an operator may legitimately reprice a private model to free.
 * Returns a typed `Catalog` on success.
 *
 * Exported so pricing.ts can reuse the same single trust-boundary rule for
 * its custom-`COWORK_MODEL_CATALOG_URL` path instead of maintaining a
 * parallel copy (which would drift and weaken whichever copy lags).
 */
export function isValidCatalog(value: unknown): value is Catalog {
  if (!value || typeof value !== "object") return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return false;
    const provider = entry as Record<string, unknown>;
    if (typeof provider.id !== "string" || typeof provider.name !== "string") return false;
    if (!provider.models || typeof provider.models !== "object") return false;
    for (const model of Object.values(provider.models as Record<string, unknown>)) {
      if (!model || typeof model !== "object") return false;
      const m = model as Record<string, unknown>;
 // `release_date` and `name` are dereferenced via `.localeCompare` /
 // `.toLowerCase()` by callers (`getModelsForProvider`, `searchModels`);
 // a non-string here would throw and crash the picker, so reject it.
      if (
        typeof m.id !== "string" ||
        typeof m.name !== "string" ||
        typeof m.release_date !== "string"
      ) return false;
      if (m.cost !== undefined) {
        const c = m.cost as Record<string, unknown>;
 // Reject non-numeric OR negative cost rates. A negative rate would flow
 // into `estimateCost` (pricing.ts) and subtract from accumulated spend,
 // silently defeating the cost cap. Zero is permitted (operator may
 // reprice a private model to free); only strictly-negative values are
 // treated as malformed/compromised. `cache_read`/`cache_write` follow
 // the same rule when present.
        if (
          typeof c.input !== "number" ||
          typeof c.output !== "number" ||
          c.input < 0 ||
          c.output < 0
        ) return false;
        if (c.cache_read !== undefined && (typeof c.cache_read !== "number" || c.cache_read < 0)) return false;
        if (c.cache_write !== undefined && (typeof c.cache_write !== "number" || c.cache_write < 0)) return false;
      }
    }
  }
  return true;
}

/**
 * Fetch the models.dev catalog. Uses a 5-minute TTL cache stored in
 * `chrome.storage.local` (extension) or in-memory (demo/Node). Falls back
 * gracefully on network failure — returns the cached version if available,
 * or an empty catalog if not.
 */
export async function fetchCatalog(force = false): Promise<Catalog> {
 // Reuse an in-flight fetch so concurrent callers share one network request.
 // Without this, a service worker handling several overlapping model-picker
 // requests would each issue a 10s fetch + a chrome.storage.local write.
  if (!force && inflight) return inflight;

 // Fast in-memory hit (synchronous — safe to short-circuit before memoizing).
  if (!force && memoryCache && Date.now() - memoryCacheTime < CACHE_TTL_MS) {
    return memoryCache;
  }

 // Memoize synchronously so any caller entering during `loadCatalog`'s awaits
 // reuses this single in-flight promise instead of starting its own fetch.
  let resolveFn!: (value: Catalog) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<Catalog>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  inflight = promise;

  (async () => {
    try {
      resolveFn(await loadCatalog(force));
    } catch (err) {
      rejectFn(err);
    } finally {
 // Only clear the shared `inflight` slot if it still points at THIS
 // promise. A concurrent force/non-force call may have started a newer
 // fetch and overwritten `inflight` while we were awaiting; clearing it
 // then would orphan that newer in-flight promise and let a later caller
 // kick off a redundant third fetch. Capturing the local `promise`
 // defends the dedup guarantee for overlapping requests.
      if (inflight === promise) inflight = null;
    }
  })();

  return promise;
}

/**
 * Read the persistent cache entry (chrome.storage.local) and re-validate it
 * with {@link isValidCatalog} before it is trusted. Swallows storage errors and
 * returns `null` when no usable entry is present.
 */
async function readCachedCatalog(): Promise<CachedCatalog | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  try {
    const cached = await chrome.storage.local.get(CACHE_KEY);
    const entry = cached[CACHE_KEY] as CachedCatalog | undefined;
 // Trust-boundary guard: a corrupted/compromised persisted entry must be
 // re-validated before it is served. `isValidCatalog` rejects non-string
 // `release_date` etc., which would otherwise crash the model picker.
    if (entry && isValidCatalog(entry.data)) return entry;
  } catch { /* ignore storage errors */ }
  return null;
}

/**
 * Perform the actual cache-lookup + network fetch for `fetchCatalog`.
 * Never throws: on any network/validation failure it falls back to the stale
 * persistent cache, and finally to an empty catalog.
 */
async function loadCatalog(force: boolean): Promise<Catalog> {
 // Check persistent cache (chrome.storage.local)
  if (!force) {
    const cached = await readCachedCatalog();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      memoryCache = cached.data;
      memoryCacheTime = cached.fetchedAt;
      return cached.data;
    }
  }

 // Fetch from models.dev
  try {
 // The `User-Agent` header is a forbidden header name in browser/SW fetch
 // (silently dropped per Fetch spec §3.4). models.dev doesn't require a UA.
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`models.dev API ${res.status}`);
    const raw = await res.json();
    if (!isValidCatalog(raw)) {
 // Trust-boundary guard: reject malformed/compromised data and fall back.
      throw new Error("models.dev catalog failed shape validation");
    }
    const data = raw;
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
  } catch (err) {
 // Log the failure for the dev-console staleness warning.
    const fetchError = err instanceof Error ? err : new Error(String(err));
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.NODE_ENV !== "production"
    ) {
      console.warn("[catalog] fetchCatalog failed:", fetchError.message);
    }
 // Network/validation failure — try stale cache
    const cached = await readCachedCatalog();
    if (cached) return cached.data;
 // No cache available — return empty
    return {};
  }
}

/**
 * Get all models for a specific provider from the catalog.
 * Returns an array of { id, name, ... } sorted by release date (newest first).
 */
/** Non-deprecated models for a provider — the "usable" set. */
function usableModels(provider: CatalogProvider): CatalogModel[] {
  return Object.values(provider.models).filter((m) => m.status !== "deprecated");
}

export async function getModelsForProvider(providerId: string): Promise<CatalogModel[]> {
  try {
    const catalog = await fetchCatalog();
    const provider = catalog[providerId];
    if (!provider || !provider.models) return [];
    return usableModels(provider)
      .sort((a, b) => {
 // Defensive: a malformed cached entry could have a non-string
 // `release_date`. Coerce to "" so `.localeCompare` never throws and
 // the model picker degrades gracefully instead of crashing (mirrors
 // the defensive `try/catch` in `getDefaultModelForProvider`).
        const da = typeof a.release_date === "string" ? a.release_date : "";
        const db = typeof b.release_date === "string" ? b.release_date : "";
        return db.localeCompare(da);
      });
  } catch {
 // Catalog unreachable (offline, network error, or a stale cache that
 // failed re-validation) — the picker should show an empty list rather
 // than throw and break the UI.
    return [];
  }
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
 * "google", "anthropic") — NOT the extension's
 * provider id. Use `CATALOG_PROVIDER_ID_MAP` to map.
 */
export async function getDefaultModelForProvider(
  catalogProviderId: string,
): Promise<string | undefined> {
  try {
    const catalog = await fetchCatalog();
    const provider = catalog[catalogProviderId];
    if (!provider || !provider.models) return undefined;
    const models = usableModels(provider)
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
  if (q === "") {
 // Empty query → return the full usable catalog (newest-first) so a cleared
 // search box shows the whole picker rather than an empty list.
    const all: Array<{ providerId: string; providerName: string; model: CatalogModel }> = [];
    for (const [providerId, provider] of Object.entries(catalog)) {
      if (!provider?.models) continue;
      for (const model of usableModels(provider)) {
        all.push({ providerId, providerName: provider.name, model });
      }
    }
    return all
      .sort((a, b) => b.model.release_date.localeCompare(a.model.release_date))
      .slice(0, limit);
  }
  const results: Array<{ providerId: string; providerName: string; model: CatalogModel; score: number }> = [];

  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider?.models) continue;
    for (const model of usableModels(provider)) {
      const modelId = typeof model.id === "string" ? model.id.toLowerCase() : "";
      const modelName = typeof model.name === "string" ? model.name.toLowerCase() : "";
      const providerName = typeof provider.name === "string" ? provider.name.toLowerCase() : "";

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
 * "claude-sonnet-5").
 * @param providerId The provider id (e.g. "openai", "ollama"). Used to look
 * up the catalog entry.
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
 // An EXACT id match is conclusive: trust its `attachment`/`modalities`
 // signals directly (including an explicit `attachment: false`).
      if (exact) {
 // `attachment: true` means the model accepts file/image attachments.
        if (exact.attachment) return true;
 // Also check `modalities.input` for "image" — some providers declare
 // it there instead of via `attachment`.
        if (exact.modalities?.input?.some((m) => m.toLowerCase().includes("image"))) return true;
 // If the catalog explicitly says `attachment: false`, trust it.
        if (exact.attachment === false) return false;
      }
 // Substring matches are ambiguous (e.g. "gpt-4" may match a non-vision
 // base variant before a vision variant, alphabetically). Don't
 // short-circuit on the first such match: if ANY substring match is
 // vision-capable we return true; otherwise we fall through to the
 // name-based heuristic instead of returning false — an inconclusive
 // substring match must not wrongly gate vision input.
      const substringMatches = models.filter((m) =>
        m.id.toLowerCase().includes(modelId.toLowerCase())
      );
      if (substringMatches.length > 0) {
        const vision = substringMatches.find(
          (m) =>
            m.attachment ||
            m.modalities?.input?.some((x) => x.toLowerCase().includes("image"))
        );
        if (vision) return true;
 // No vision-capable substring match and no conclusive exact match:
 // fall through to the heuristic below (do NOT return false).
      }
    } catch {
 // Catalog unavailable (offline, network error) — fall through to heuristic.
    }
  }

 // Fallback: heuristic name-based check for common vision-capable model
 // families. This catches local Ollama models, newly-released models not yet
 // in the catalog, and custom OpenAI-compatible endpoints. `VISION_PATTERNS`
 // is the module-scope, word-boundary-anchored list (see its doc-comment for
 // why `includes` was replaced).
  const name = modelId.toLowerCase();
  return VISION_PATTERNS.some((re) => re.test(name));
}

/**
 * Format a model's vision capability for display in the UI.
 * Returns "Vision" if the model supports image inputs, "" otherwise.
 */
export function formatVision(attachment?: boolean): string {
  return attachment ? "Vision" : "";
}

