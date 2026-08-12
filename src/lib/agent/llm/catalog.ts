/**
 * models.dev catalog — runtime layer for the model/provider registry.
 *
 * Re-exports all types, constants, and pure helpers from {@link catalog-data}.
 * This module owns mutable runtime state (merged cache, search index, fetch
 * deduplication) and the I/O path (live catalog fetch + chrome.storage cache).
 */

/* ============================================================= *
 * Re-exports from catalog-data (single source of truth).       *
 * ============================================================= */

export type {
  CatalogModel,
  Catalog,
  ReasoningOption,
};
export {
  isValidCatalog,
  reasoningOptionsFor,
} from "./catalog-data";

import {
  BUNDLED_CATALOG,
  CACHE_TTL_MS,
  CACHE_KEY,
  CATALOG_URL,
  VISION_PATTERNS,
  REASONING_PATTERNS,
  isValidCatalog,
  mergeCatalogs,
  type CatalogModel,
  type CatalogProvider,
  type Catalog,
  type CachedCatalog,
  type ReasoningOption,
} from "./catalog-data";

/* ============================================================= *
 * Constants & shared state.                                    *
 * ============================================================= */

/**
 * The merged catalog that synchronous accessors read from. Seeded at module
 * load with the bundled snapshot, so it is always valid offline; once
 * `fetchCatalog` successfully merges the live catalog it is replaced here.
 */
let mergedCache: Catalog = { ...BUNDLED_CATALOG };
/** Timestamp (ms) of the last in-memory `mergedCache` population. */
let memoryCacheTime = 0;
/** In-flight fetch promise, memoized to dedupe concurrent callers. */
let inflight: Promise<Catalog> | null = null;
/** AbortController for the in-flight fetch — aborted when force=true supersedes it. */
let inflightController: AbortController | null = null;
/**
 * Whether the most recent `loadCatalog` completed a LIVE merge (vs falling
 * back to the stale cache / bundled snapshot). `fetchCatalog` never throws by
 * contract, so consumers that need to distinguish "live rates" from "fallback
 * rates" (pricing's lazy refresh) read this instead of inferring success.
 */
let liveFetchSucceeded = false;

/** Whether the most recent catalog load completed a live merge. */
export function catalogFetchSucceeded(): boolean {
  return liveFetchSucceeded;
}

/** One-shot stale-while-refresh timer handle (null when none is pending). */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm a one-shot stale-while-refresh: `CACHE_TTL_MS` after the last successful
 * live load, re-fetch the catalog with `force`. Re-armed by `loadCatalog` after
 * every successful live merge, so a long-lived session keeps picking up fresh
 * rates. At most one timer is ever pending; the fire-time inflight check
 * dedupes against a concurrent fetch (that fetch re-arms on success).
 */
export function scheduleRefresh(): void {
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (inflight) return;
    void fetchCatalog({ force: true });
  }, CACHE_TTL_MS);
}

/** Reset all mutable module state (test isolation). */
export function __resetCatalogForTests(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  inflight = null;
  inflightController = null;
  mergedCache = { ...BUNDLED_CATALOG };
  memoryCacheTime = 0;
  liveFetchSucceeded = false;
  searchIndex = null;
  searchIndexTime = 0;
}

/**
 * Memoized lowercase search index. `searchModels` is keystroke-driven, so we
 * precompute the lowercased id/name/family haystack for every model ONCE per
 * catalog version (keyed by `memoryCacheTime`) instead of re-lowercasing the
 * ~5500 models and re-sorting on every keystroke. Invalidated whenever the
 * merged catalog is repopulated.
 */
interface SearchIndexEntry {
  providerId: string;
  providerName: string;
  lower: string;
  model: CatalogModel;
}
let searchIndex: SearchIndexEntry[] | null = null;
let searchIndexTime = 0;

/** Build (or return the cached) precomputed lowercase search index. */
function getSearchIndex(): SearchIndexEntry[] {
  if (searchIndex && searchIndexTime === memoryCacheTime) return searchIndex;
  const all: SearchIndexEntry[] = [];
  for (const [providerId, provider] of Object.entries(mergedCache)) {
    if (!provider?.models) continue;
    const providerName = provider.name;
    for (const model of Object.values(provider.models)) {
      all.push({
        providerId,
        providerName,
        lower: `${model.id}\n${model.name}\n${model.family ?? ""}`.toLowerCase(),
        model,
      });
    }
  }
  searchIndex = all;
  searchIndexTime = memoryCacheTime;
  return all;
}

/* ============================================================= *
 * Merge + fetch (live merged OVER bundled; additive; cached).  *
 * ============================================================= */

/** Storage area to use for the 5-min cache: `session` if present, else `local`. */
function cacheStorage():
  | { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void> }
  | undefined {
  if (typeof chrome === "undefined" || !chrome.storage) return undefined;
  const store = (chrome.storage as any).session ?? chrome.storage.local;
  if (!store) return undefined;
  return {
    get: (k: string) => store.get(k),
    set: (v: Record<string, unknown>) => store.set(v),
  };
}

/**
 * Read the persistent cache entry and re-validate it with {@link isValidCatalog}
 * before it is trusted. Swallows storage errors and returns `null` when no
 * usable entry is present.
 */
async function readCachedCatalog(): Promise<CachedCatalog | null> {
  const store = cacheStorage();
  if (!store) return null;
  try {
    const cached = await store.get(CACHE_KEY);
    const entry = (cached as Record<string, CachedCatalog | undefined>)[CACHE_KEY];
    if (entry && isValidCatalog(entry.data)) return entry;
  } catch {
    /* ignore storage errors */
  }
  return null;
}

/**
 * Perform the cache-lookup + network fetch used by {@link fetchCatalog}.
 * Never throws: on any network/validation failure it falls back to the stale
 * persistent cache, and finally returns the bundled snapshot.
 */
async function loadCatalog(force: boolean, signal?: AbortSignal): Promise<Catalog> {
  if (!force) {
    const cached = await readCachedCatalog();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      mergedCache = cached.data;
      memoryCacheTime = cached.fetchedAt;
      return cached.data;
    }
  }

  try {
    const timeoutSignal = AbortSignal.timeout(10_000);
    const fetchSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const res = await fetch(CATALOG_URL, { signal: fetchSignal, credentials: "omit" });
    if (!res.ok) throw new Error(`models.dev API ${res.status}`);
    const raw = await res.json();
    if (!isValidCatalog(raw)) {
      throw new Error("models.dev catalog failed shape validation");
    }
    const merged = mergeCatalogs(BUNDLED_CATALOG, raw);
    mergedCache = merged;
    memoryCacheTime = Date.now();
    liveFetchSucceeded = true;
    // Stale-while-refresh: every successful live load arms the next one-shot
    // refresh (fire-once-per-successful-load; a failed refresh never re-arms).
    scheduleRefresh();

    const store = cacheStorage();
    if (store) {
      try {
        await store.set({ [CACHE_KEY]: { data: merged, fetchedAt: memoryCacheTime } as CachedCatalog });
      } catch {
        /* ignore storage quota errors */
      }
    }
    return merged;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[catalog] fetchCatalog failed, using bundled:", msg);
    liveFetchSucceeded = false;
    const cached = await readCachedCatalog();
    if (cached) {
      mergedCache = cached.data;
      memoryCacheTime = cached.fetchedAt;
      return cached.data;
    }
    mergedCache = { ...BUNDLED_CATALOG };
    memoryCacheTime = Date.now();
    return BUNDLED_CATALOG;
  }
}

interface FetchCatalogOptions {
  force?: boolean;
}
/**
 * Get the merged catalog (bundled snapshot + live refresh layered on top).
 * Accepts either a boolean `force` (legacy) or an options object. Swallows all
 * network/storage errors so the bundled snapshot is always returned offline.
 */
export async function fetchCatalog(
  opts?: FetchCatalogOptions | boolean,
): Promise<Catalog> {
  const force = typeof opts === "boolean" ? opts : (opts?.force ?? false);

  if (!force && inflight) return inflight;

  if (!force && Date.now() - memoryCacheTime < CACHE_TTL_MS) {
    return mergedCache;
  }

  if (force && inflightController) {
    inflightController.abort();
  }

  const controller = new AbortController();
  inflightController = controller;

  let resolveFn!: (value: Catalog) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<Catalog>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  inflight = promise;

  (async () => {
    try {
      resolveFn(await loadCatalog(force, controller.signal));
    } catch (err) {
      rejectFn(err);
    } finally {
      if (inflight === promise) {
        inflight = null;
        inflightController = null;
      }
    }
  })();

  return promise;
}

/* ============================================================= *
 * Synchronous accessors (read the merged cache; bundled offline).*
 * ============================================================= */

/** All providers, in insertion order. */
export function getProviders(): CatalogProvider[] {
  return Object.values(mergedCache);
}

/** A single provider by id, or `undefined`. */
export function getProvider(id: string): CatalogProvider | undefined {
  return mergedCache[id];
}

/**
 * All models for a provider, sorted newest-first by `release_date` with
 * deprecated models last. Synchronous over the merged cache.
 */
export function getModelsForProvider(id: string): CatalogModel[];
/**
 * A single model resolved by `modelId` (within `id`), WITHOUT sorting the full
 * model list. Tolerates OpenRouter-style `provider/` prefixes via
 * {@link catalogIdMatches}. Returns `undefined` if the provider/model is
 * unknown. Synchronous over the merged cache.
 */
export function getModelsForProvider(id: string, modelId: string): CatalogModel | undefined;
export function getModelsForProvider(
  id: string,
  modelId?: string,
): CatalogModel[] | CatalogModel | undefined {
  const provider = mergedCache[id];
  if (!provider || !provider.models) return modelId !== undefined ? undefined : [];
  if (modelId !== undefined) {
    return Object.values(provider.models).find((m) => catalogIdMatches(modelId, m.id));
  }
  return Object.values(provider.models).sort((a, b) => {
    const aDep = a.status === "deprecated" ? 1 : 0;
    const bDep = b.status === "deprecated" ? 1 : 0;
    if (aDep !== bDep) return aDep - bDep;
    const da = typeof a.release_date === "string" ? a.release_date : "";
    const db = typeof b.release_date === "string" ? b.release_date : "";
    return db.localeCompare(da);
  });
}

/**
 * The self-updating default model id for a provider over the merged catalog.
 *
 * When a `priority` family list is supplied, the first STABLE member present in
 * the catalog wins (matched via {@link catalogIdMatches}, so provider-prefixed
 * entries work). Experimental (alpha/beta) and deprecated entries are skipped —
 * a default must never silently select a model that requires an explicit
 * opt-in. Otherwise (or when no priority entry matches) the newest model that
 * is not `deprecated` is chosen, preferring a stable (non-alpha / non-beta)
 * model when alternatives exist. Returns `""` when the provider is unknown,
 * has no usable models, or every non-deprecated model is experimental
 * (alpha/beta) — those providers require an explicit model choice.
 */
export function getDefaultModelForProvider(id: string, priority?: string[]): string {
  const provider = mergedCache[id];
  if (!provider || !provider.models) return "";
  const usable = Object.values(provider.models).filter((m) => m.status !== "deprecated");
  if (usable.length === 0) return "";
  if (priority && priority.length > 0) {
    for (const wanted of priority) {
      const hit = usable.find((m) => catalogIdMatches(wanted, m.id));
      if (!hit) continue;
      if (hit.status === "alpha" || hit.status === "beta") continue;
      return hit.id;
    }
  }
  usable.sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")));
  const stable = usable.filter((m) => m.status !== "alpha" && m.status !== "beta");
  return stable.length > 0 ? stable[0].id : "";
}

/**
 * Search across ALL providers + models. Case-insensitive substring match over
 * model id + name + family; results newest-first. Deprecated models are
 * excluded unless they are the only matches for the query.
 */
export function searchModels(
  query: string,
  limit = 10,
): Array<{ providerId: string; providerName: string; model: CatalogModel }> {
  const q = query.toLowerCase().trim();
  const index = getSearchIndex();
  const all: Array<{ providerId: string; providerName: string; model: CatalogModel }> = [];

  for (const e of index) {
    if (q === "" || e.lower.includes(q)) {
      all.push({ providerId: e.providerId, providerName: e.providerName, model: e.model });
    }
  }

  const nonDeprecated = all.filter((x) => x.model.status !== "deprecated");
  const pool = nonDeprecated.length > 0 ? nonDeprecated : all;

  pool.sort((a, b) => String(b.model.release_date ?? "").localeCompare(String(a.model.release_date ?? "")));
  return pool.slice(0, limit);
}

/* ============================================================= *
 * Capability resolution (boolean fields preferred; heuristics  *
 * as fallback when the catalog is unavailable).                *
 * ============================================================= */

/** OpenRouter `:variant` suffix (`:free`, `:nitro`, `:floor`, `:extended`,
 * `:thinking`, or any `:[a-z0-9-]+`) — stripped before model-id comparison so
 * `openai/gpt-oss-20b:free` resolves to the bare catalog record + real rates. */
const OPENROUTER_VARIANT_SUFFIX_RE = /:(?:free|nitro|floor|extended|thinking|[a-z0-9-]+)$/;
/** Trailing `-YYYYMMDD` snapshot suffix (e.g. `gpt-4o-2024-11-20`). */
const DATESTAMP_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/;

/** Canonicalize a model id for comparison: lowercase, strip an OpenRouter
 * `:variant` suffix, and strip a trailing date-stamp so undated vs dated
 * spellings (`gpt-4o` vs `gpt-4o-2024-11-20`) collapse to one record. */
export function canonicalizeModelId(s: string): string {
  return s.toLowerCase().trim().replace(OPENROUTER_VARIANT_SUFFIX_RE, "").replace(DATESTAMP_SUFFIX_RE, "");
}

/**
 * Compare a requested model id against a catalog model id, tolerating the
 * OpenRouter-style `provider/` prefix plus `:variant` and date-stamp suffixes.
 * Uses exact segment matching (not substring) to avoid false positives
 * (e.g. `gpt-4o` must NOT match `gpt-4o-mini`).
 */
export function catalogIdMatches(requested: string, catalogId: string): boolean {
  const reqRaw = requested.toLowerCase();
  const catRaw = catalogId.toLowerCase();
  if (reqRaw === catRaw) return true;
  const req = canonicalizeModelId(reqRaw);
  const cat = canonicalizeModelId(catRaw);
  if (req === cat) return true;
  const strip = (s: string) => {
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  };
  if (strip(req) === strip(cat)) return true;
  if (req.endsWith("/" + cat)) return true;
  if (cat.endsWith("/" + req)) return true;
  return false;
}

/**
 * Decide whether `modelId` is a reasoning model given the catalog models for
 * its provider. Pure (no I/O); `REASONING_PATTERNS` is the final fallback
 * whenever the catalog gives no conclusive signal.
 */
function resolveReasoningSupport(modelId: string, models: CatalogModel[]): boolean {
  if (models.length > 0) {
    const exact = models.find((m) => catalogIdMatches(modelId, m.id));
    if (exact) return exact.reasoning === true;
  }
  const name = modelId.toLowerCase();
  return REASONING_PATTERNS.some((re) => re.test(name));
}

/** Check if a model supports vision based on its boolean/modalities fields. */
function isVisionModel(m: CatalogModel): boolean {
  if (m.attachment) return true;
  if (m.modalities?.input?.some((x) => x.toLowerCase().includes("image"))) return true;
  return false;
}

/**
 * Decide whether `modelId` supports vision given the catalog models for its
 * provider. Pure (no I/O).
 */
export function resolveVisionSupport(modelId: string, models: CatalogModel[]): boolean {
  const name = modelId.toLowerCase();
  if (models.length > 0) {
    const reqBase = name.replace(/-?\d{4}-\d{2}-\d{2}$/, "");
    const exact = models.find((m) => catalogIdMatches(modelId, m.id));
    if (exact) {
      if (isVisionModel(exact)) return true;
  // An explicit `attachment: false` on the exact match wins over the
  // VISION_PATTERNS heuristic — the heuristic is a fallback for models the
  // catalog has NO opinion about, and its patterns (`\bgpt-4o\b`,
  // `\bclaude-3\b`, `\bgemini\b`, …) are broad enough to match non-vision
  // models the catalog explicitly marks otherwise (e.g. a text-only
  // `grok-3`-style variant of a vision family). The screenshot gate would
  // otherwise attach images to models that reject them.
      if (exact.attachment === false) return false;
    }
    const substringMatches = models.filter((m) => m.id.toLowerCase().includes(name));
    if (substringMatches.length > 0) {
      const vision = substringMatches.find((m) => {
        if (!isVisionModel(m)) return false;
        const id = m.id.toLowerCase();
        const idBase = id.replace(/-?\d{4}-\d{2}-\d{2}$/, "");
        return id === name || idBase === reqBase;
      });
      if (vision) return true;
    }
  }
  return VISION_PATTERNS.some((re) => re.test(name));
}

/** Whether a catalog model supports vision, based on its boolean fields. */
export function modelSupportsVision(m: CatalogModel): boolean;
/** Whether `modelId` (resolved within `providerId`) supports vision. */
export function modelSupportsVision(modelId: string, providerId?: string): Promise<boolean>;
export function modelSupportsVision(
  mOrId: CatalogModel | string,
  providerId?: string,
): boolean | Promise<boolean> {
  if (typeof mOrId === "string") {
    return resolveCapability(mOrId, providerId, resolveVisionSupport);
  }
  if (isVisionModel(mOrId)) return true;
  return resolveVisionSupport(mOrId.id, []);
}

/** Whether a catalog model is a reasoning model, based on its `reasoning` boolean. */
export function modelSupportsReasoning(m: CatalogModel): boolean;
/** Whether `modelId` (resolved within `providerId`) is a reasoning model. */
export function modelSupportsReasoning(modelId: string, providerId?: string): Promise<boolean>;
export function modelSupportsReasoning(
  mOrId: CatalogModel | string,
  providerId?: string,
): boolean | Promise<boolean> {
  if (typeof mOrId === "string") {
    return resolveCapability(mOrId, providerId, resolveReasoningSupport);
  }
  if (mOrId.reasoning) return true;
  return resolveReasoningSupport(mOrId.id, []);
}

function resolveCapability(
  modelId: string,
  providerId: string | undefined,
  resolver: (modelId: string, models: CatalogModel[]) => boolean,
): Promise<boolean> {
  if (providerId) {
    const exact = getModelsForProvider(providerId, modelId);
    if (exact) return Promise.resolve(resolver(modelId, [exact]));
  }
  const models = providerId ? getModelsForProvider(providerId) : [];
  return Promise.resolve(resolver(modelId, models));
}

/* ============================================================= *
 * Display formatters.                                           *
 * ============================================================= */

/** Format a model's cost for display, e.g. "$1.25 in / $10.00 out". */
export function formatCost(cost?: CatalogModel["cost"]): string {
  if (!cost) return "—";
  if (cost.input === 0 && cost.output === 0) return "Free";
  let s = `$${cost.input.toFixed(2)} in / $${cost.output.toFixed(2)} out`;
  const parts: string[] = [];
  if (cost.cache_read !== undefined) parts.push(`$${cost.cache_read.toFixed(3)} cache-r`);
  if (cost.cache_write !== undefined) parts.push(`$${cost.cache_write.toFixed(3)} cache-w`);
  if (parts.length > 0) s += " / " + parts.join(" / ");
  return s;
}

/** Format a model's context window for display, e.g. "400K ctx". */
export function formatContext(limit?: CatalogModel["limit"]): string {
  if (!limit) return "—";
  const ctx = limit.context;
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M ctx`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K ctx`;
  return `${ctx} ctx`;
}

/**
 * Format a model's vision capability for display.
 * Returns "vision" if the model supports image inputs, "" otherwise.
 */
export function formatVision(attachment?: boolean): string {
  return attachment ? "vision" : "";
}
