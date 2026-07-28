/**
 * models.dev catalog — the central model/provider registry for the agent.
 *
 * Offline-primary: the `@opencode-ai/models` SDK's snapshot is the committed
 * data source imported here as `BUNDLED_CATALOG`. It is always available at boot
 * with zero network, so the model picker works offline and never crashes when
 * the network is down.
 *
 * Refresh/merge layer: `fetchCatalog` lazily fetches the LIVE
 * `https://models.dev/api.json` and merges it OVER the bundled snapshot.
 * The merge is additive (bundled providers are never dropped) and live wins on
 * id conflicts. The live result is cached 5 minutes (in-memory +
 * `chrome.storage.session` when available), and every network/storage call is
 * guarded in try/catch so an offline or failed refresh transparently falls back
 * to the bundled snapshot.
 *
 * Note on ids: OpenRouter model ids use DOTS, not hyphens
 * (e.g. `anthropic/claude-3.5-sonnet`). The `id` fields in this catalog preserve
 * that — match on exact `id`, not a hyphen-normalized form.
 */

/* ============================================================= *
 * Authoritative types (Agent A's bundle conforms to these).    *
 * ============================================================= */

/** A single model in the models.dev catalog. */
export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  description?: string;
  release_date: string;
  last_updated?: string;
  knowledge?: string;
  attachment: boolean;
  reasoning: boolean;
  temperature?: boolean;
  tool_call: boolean;
  structured_output?: boolean;
  open_weights?: boolean;
  status?: string; // "alpha" | "beta" | "deprecated"
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context: number; input?: number; output: number };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
    input_audio?: number;
    output_audio?: number;
  };
}

/** A provider in the models.dev catalog. */
export interface CatalogProvider {
  id: string;
  name: string;
  api?: string;
  env?: string[];
  npm?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
}

/** The full catalog — a map of provider ID → provider info. */
export type Catalog = Record<string, CatalogProvider>;

/* ============================================================= *
 * Offline-primary snapshot (from @opencode-ai/models SDK).     *
 * ============================================================= */

import { providers as BUNDLED_CATALOG } from "@opencode-ai/models/snapshot";

/* ============================================================= *
 * Constants & shared state.                                    *
 * ============================================================= */

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_KEY = "__opencowork_models_dev_catalog";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

/**
 * Memoized lowercase search index. `searchModels` is keystroke-driven, so we
 * precompute the lowercased id/name/family haystack for every model ONCE per
 * catalog version (keyed by `memoryCacheTime`) instead of re-lowercasing the
 * ~5500 models and re-sorting on every keystroke. Invalidated whenever the
 * merged catalog is repopulated.
 */
let searchIndex: Array<{ providerId: string; providerName: string; lower: string; model: CatalogModel }> | null = null;
let searchIndexTime = 0;

/** Build (or return the cached) precomputed lowercase search index. */
function getSearchIndex(): Array<{ providerId: string; providerName: string; lower: string; model: CatalogModel }> {
  if (searchIndex && searchIndexTime === memoryCacheTime) return searchIndex;
  const all: Array<{ providerId: string; providerName: string; lower: string; model: CatalogModel }> = [];
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
 * Fallback heuristics (used only when the catalog is absent).  *
 * ============================================================= */

/**
 * Heuristic vision-capable model-name patterns (fallback used only when a
 * model is NOT in the catalog). Hoisted to module scope so it is allocated
 * once per process, not on every `modelSupportsVision` call.
 *
 * Word-boundary (`\b`) matching replaces the previous `name.includes(kw)`
 * scan: a bare `includes("vl")` matched any id containing those two letters
 * (e.g. a non-vision model whose name happened to include "vl"), feeding the
 * wrong screenshot-gating path. Anchoring each token to a word boundary keeps
 * the heuristic precise while still catching the common vision families
 * (qwen-vl, deepseek-vl, gpt-4o, claude-3, gemini, …).
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

/**
 * Name/id patterns for reasoning models. These models reject or ignore the
 * `temperature` parameter and instead use `max_completion_tokens` for their
 * thinking budget (e.g. OpenAI o1/o3/o4, xAI grok-4-reasoning). Sending
 * `temperature` to them can produce an HTTP 400 or silently waste the
 * parameter, so callers must omit temperature for them.
 */
const REASONING_PATTERNS: RegExp[] = [
  /\bo1\b/i,
  /\bo1-?mini\b/i,
  /\bo3\b/i,
  /\bo3-?mini\b/i,
  /\bo4\b/i,
  /\bo4-?mini\b/i,
  /\bgrok-4-?reasoning\b/i,
  /\bdeepseek-?reasoner\b/i,
  /\bclaude-sonnet-5\b/i,
  // models.dev ids use DOTS between version segments (e.g. `claude-opus-4.8`),
  // but some endpoints / resolved model ids surface the hyphenated form
  // (`claude-opus-4-8`). A `[.-]` character class matches BOTH so the reasoning
  // heuristic never misses a reasoning model and wrongly sends `temperature`
  // (which produces an HTTP 400 on reasoning models). The provider-name hyphens
  // (`claude-sonnet`, `claude-opus`) are intentionally left untouched.
  /\bclaude-sonnet-4[.-]5\b/i,
  /\bclaude-opus-4[.-]1\b/i,
  /\bclaude-opus-4[.-]8\b/i,
];

/* ============================================================= *
 * Validation (single trust boundary for any untrusted catalog).*
 * ============================================================= */

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
      // `.toLowerCase()` by callers; a non-string here would throw and crash
      // the picker, so reject it.
      if (
        typeof m.id !== "string" ||
        typeof m.name !== "string" ||
        typeof m.release_date !== "string"
      ) return false;
      if (m.cost !== undefined) {
        const c = m.cost as Record<string, unknown>;
        // Reject non-numeric OR negative cost rates (see header note on the
        // cost-cap). `cache_read`/`cache_write`/`reasoning`/audio rates follow
        // the same rule when present.
        const inputRate = c.input;
        const outputRate = c.output;
        if (
          typeof inputRate !== "number" ||
          !Number.isFinite(inputRate) ||
          inputRate < 0 ||
          typeof outputRate !== "number" ||
          !Number.isFinite(outputRate) ||
          outputRate < 0
        ) return false;
        const rateOk = (v: unknown) =>
          v === undefined || (typeof v === "number" && v >= 0);
        if (
          !rateOk(c.cache_read) ||
          !rateOk(c.cache_write) ||
          !rateOk(c.reasoning) ||
          !rateOk(c.input_audio) ||
          !rateOk(c.output_audio)
        ) return false;
      }
      // `attachment` is read as a truthy boolean to gate whether a
      // `<screenshot>` image is attached; a non-boolean would coerce to truthy
      // and treat a non-vision model as vision-capable. `limit.context` is
      // rendered verbatim by `formatContext`; a non-number, or context < 1, is
      // malformed/compromised data that must not reach the picker.
      if (m.attachment !== undefined && typeof m.attachment !== "boolean") return false;
      if (m.limit !== undefined) {
        const lim = m.limit as Record<string, unknown>;
        const ctxLimit = lim.context;
        const outLimit = lim.output;
        if (
          typeof ctxLimit !== "number" ||
          !Number.isFinite(ctxLimit) ||
          ctxLimit < 1 ||
          typeof outLimit !== "number" ||
          !Number.isFinite(outLimit) ||
          outLimit < 0
        ) return false;
      }
    }
  }
  return true;
}

/* ============================================================= *
 * Merge + fetch (live merged OVER bundled; additive; cached).  *
 * ============================================================= */

/**
 * Merge `live` OVER `base`. Bundled providers/models are never dropped
 * (additive); for any provider or model id present in both, the live entry
 * wins. Returns a fresh `Catalog` (no mutation of the inputs).
 */
function mergeCatalogs(base: Catalog, live: Catalog): Catalog {
  const out: Catalog = {};
  for (const [pid, provider] of Object.entries(base)) {
    out[pid] = { ...provider, models: { ...provider.models } };
  }
  for (const [pid, liveProvider] of Object.entries(live)) {
    const baseProvider = out[pid];
    if (!baseProvider) {
      out[pid] = { ...liveProvider, models: { ...liveProvider.models } };
      continue;
    }
    const merged: CatalogProvider = {
      ...baseProvider,
      ...liveProvider,
      models: { ...baseProvider.models },
    };
    for (const [mid, liveModel] of Object.entries(liveProvider.models)) {
      merged.models[mid] = liveModel; // live wins on id conflict
    }
    out[pid] = merged;
  }
  return out;
}

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
    // Trust-boundary guard: a corrupted/compromised persisted entry must be
    // re-validated before it is served.
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
async function loadCatalog(force: boolean): Promise<Catalog> {
  // Check persistent cache first (unless forced).
  if (!force) {
    const cached = await readCachedCatalog();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      mergedCache = cached.data;
      memoryCacheTime = cached.fetchedAt;
      return cached.data;
    }
  }

  // Fetch + merge the live catalog OVER the bundled snapshot.
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`models.dev API ${res.status}`);
    const raw = await res.json();
    if (!isValidCatalog(raw)) {
      throw new Error("models.dev catalog failed shape validation");
    }
    const merged = mergeCatalogs(BUNDLED_CATALOG, raw);
    mergedCache = merged;
    memoryCacheTime = Date.now();

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
    // Network/validation failure — try a stale cache, then bundled snapshot.
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.NODE_ENV !== "production"
    ) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[catalog] fetchCatalog failed, using bundled:", msg);
    }
    const cached = await readCachedCatalog();
    if (cached) {
      mergedCache = cached.data;
      memoryCacheTime = cached.fetchedAt;
      return cached.data;
    }
    // Offline / no cache: the bundled snapshot is always correct.
    mergedCache = { ...BUNDLED_CATALOG };
    memoryCacheTime = Date.now();
    return BUNDLED_CATALOG;
  }
}

export interface FetchCatalogOptions {
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

  // Reuse an in-flight fetch so concurrent callers share one network request.
  if (!force && inflight) return inflight;

  // Fast in-memory hit (synchronous short-circuit before memoizing).
  if (!force && Date.now() - memoryCacheTime < CACHE_TTL_MS) {
    return mergedCache;
  }

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
      // Only clear the shared slot if it still points at THIS promise (a newer
      // concurrent fetch may have overwritten `inflight` while we awaited).
      if (inflight === promise) inflight = null;
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
  // Exact-id fast path: resolve a single model without sorting the whole list
  // (~hundreds–thousands of models). Used by the per-request capability lookups.
  if (modelId !== undefined) {
    return Object.values(provider.models).find((m) => catalogIdMatches(modelId, m.id));
  }
  return Object.values(provider.models).sort((a, b) => {
    const aDep = a.status === "deprecated" ? 1 : 0;
    const bDep = b.status === "deprecated" ? 1 : 0;
    if (aDep !== bDep) return aDep - bDep; // non-deprecated first
    const da = typeof a.release_date === "string" ? a.release_date : "";
    const db = typeof b.release_date === "string" ? b.release_date : "";
    return db.localeCompare(da); // newest first
  });
}

/**
 * The self-updating default model id for a provider over the merged catalog:
 * the newest model that is not `deprecated`, preferring a stable (non-alpha /
 * non-beta) model when alternatives exist. Returns `""` if the provider is
 * unknown or has no usable models. Synchronous — callers typically `await` it,
 * which is harmless for a string return.
 */
export function getDefaultModelForProvider(id: string): string {
  const provider = mergedCache[id];
  if (!provider || !provider.models) return "";
  const usable = Object.values(provider.models).filter((m) => m.status !== "deprecated");
  if (usable.length === 0) return "";
  usable.sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? ""))); // newest first
  const stable = usable.filter((m) => m.status !== "alpha" && m.status !== "beta");
  return (stable.length > 0 ? stable : usable)[0].id;
}

/**
 * Search across ALL providers + models. Case-insensitive substring match over
 * model id + name + family; results newest-first. Deprecated models are
 * excluded unless they are the only matches for the query. Synchronous.
 */
export function searchModels(
  query: string,
  limit = 10,
): Array<{ providerId: string; providerName: string; model: CatalogModel }> {
  const q = query.toLowerCase().trim();
  const index = getSearchIndex();
  const all: Array<{ providerId: string; providerName: string; model: CatalogModel }> = [];

  if (q === "") {
    for (const e of index) all.push({ providerId: e.providerId, providerName: e.providerName, model: e.model });
  } else {
    for (const e of index) {
      if (e.lower.includes(q)) all.push({ providerId: e.providerId, providerName: e.providerName, model: e.model });
    }
  }

  // Exclude deprecated unless the query matches ONLY deprecated models.
  const nonDeprecated = all.filter((x) => x.model.status !== "deprecated");
  const pool = nonDeprecated.length > 0 ? nonDeprecated : all;

  pool.sort((a, b) => String(b.model.release_date ?? "").localeCompare(String(a.model.release_date ?? "")));
  return pool.slice(0, limit);
}

/* ============================================================= *
 * Capability resolution (boolean fields preferred; heuristics  *
 * as fallback when the catalog is unavailable).                *
 * ============================================================= */

/**
 * Compare a requested model id against a catalog model id, tolerating the
 * OpenRouter-style `provider/` prefix. The catalog stores OpenRouter models as
 * `anthropic/claude-opus-4.8` while a resolved model id may be the bare
 * `claude-opus-4.8` (or vice versa). We strip any `provider/` prefix from BOTH
 * sides and also accept `endsWith` of `/<id>` so either form resolves to the
 * same catalog entry instead of falling through to the (now fixed) heuristic.
 * Provider-name hyphens are never altered.
 *
 * Uses exact segment matching (not substring) to avoid false positives
 * (e.g. `gpt-4o` must NOT match `gpt-4o-mini`).
 */
export function catalogIdMatches(requested: string, catalogId: string): boolean {
  const req = requested.toLowerCase();
  const cat = catalogId.toLowerCase();
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
 * whenever the catalog gives no conclusive signal (offline catalog, or a
 * custom OpenAI-compatible endpoint absent from the catalog).
 */
export function resolveReasoningSupport(modelId: string, models: CatalogModel[]): boolean {
  if (models.length > 0) {
    const exact = models.find((m) => catalogIdMatches(modelId, m.id));
    if (exact) return exact.reasoning === true;
  }
  const name = modelId.toLowerCase();
  return REASONING_PATTERNS.some((re) => re.test(name));
}

/**
 * Decide whether `modelId` supports vision given the catalog models for its
 * provider. Pure (no I/O) so the trust-sensitive gating logic — which decides
 * whether a `<screenshot>` image is attached to an LLM request — is
 * unit-testable in isolation. The name-based `VISION_PATTERNS` heuristic is
 * the final fallback whenever the catalog gives no conclusive signal (no
 * provider models, an offline catalog, or an inconclusive match).
 */
export function resolveVisionSupport(modelId: string, models: CatalogModel[]): boolean {
  const name = modelId.toLowerCase();
  if (models.length > 0) {
    const reqId = name;
    const reqBase = reqId.replace(/-?\d{4}-\d{2}-\d{2}$/, "");
    const exact = models.find((m) => catalogIdMatches(modelId, m.id));
    // An EXACT id match is conclusive: trust its `attachment`/`modalities`.
    if (exact) {
      if (exact.attachment) return true;
      if (exact.modalities?.input?.some((m) => m.toLowerCase().includes("image"))) return true;
      // A wrong/negative catalog entry for a genuinely vision-capable model must
      // not permanently disable screenshot attachment: only conclude `false`
      // when the catalog is conclusive AND the name does NOT also match the
      // vision heuristic (e.g. `gpt-4o`, `claude-3`, `gemini`…).
      if (exact.attachment === false && !VISION_PATTERNS.some((re) => re.test(name))) return false;
    }
    // Substring matches are ambiguous — only treat as conclusive vision when
    // the requested id IS that vision model (possibly a dated/versioned
    // variant), not a longer id that merely contains it.
    const substringMatches = models.filter((m) => m.id.toLowerCase().includes(reqId));
    if (substringMatches.length > 0) {
      const vision = substringMatches.find((m) => {
        const id = m.id.toLowerCase();
        const isVision =
          m.attachment ||
          m.modalities?.input?.some((x) => x.toLowerCase().includes("image"));
        if (!isVision) return false;
        const idBase = id.replace(/-?\d{4}-\d{2}-\d{2}$/, "");
        return id === reqId || idBase === reqBase;
      });
      if (vision) return true;
    }
  }
  // Fallback: word-boundary heuristic for common vision-capable families.
  return VISION_PATTERNS.some((re) => re.test(name));
}

/**
 * Whether a catalog model supports vision, based on its boolean fields
 * (`attachment` / `modalities.input` image), falling back to the name
 * heuristic when those are inconclusive. Synchronous.
 */
export function modelSupportsVision(m: CatalogModel): boolean;
/**
 * Whether `modelId` (resolved within `providerId`) supports vision. Looks the
 * provider's models up in the merged catalog and delegates to
 * {@link resolveVisionSupport}, falling back to the heuristic when offline.
 */
export function modelSupportsVision(modelId: string, providerId?: string): Promise<boolean>;
export function modelSupportsVision(
  mOrId: CatalogModel | string,
  providerId?: string,
): boolean | Promise<boolean> {
  if (typeof mOrId === "string") {
    // Fast path: resolve the exact model without sorting the whole list. The
    // exact match short-circuits, so the (rare) full-list sort below only runs
    // when the model is absent from the resolved provider's catalog.
    if (providerId) {
      const exact = getModelsForProvider(providerId, mOrId);
      if (exact) return Promise.resolve(resolveVisionSupport(mOrId, [exact]));
    }
    const models = providerId ? getModelsForProvider(providerId) : [];
    return Promise.resolve(resolveVisionSupport(mOrId, models));
  }
  if (mOrId.attachment) return true;
  if (mOrId.modalities?.input?.some((x) => x.toLowerCase().includes("image"))) return true;
  return resolveVisionSupport(mOrId.id, []);
}

/**
 * Whether a catalog model is a reasoning model, based on its `reasoning`
 * boolean, falling back to the name heuristic. Synchronous.
 */
export function modelSupportsReasoning(m: CatalogModel): boolean;
/**
 * Whether `modelId` (resolved within `providerId`) is a reasoning model. Looks
 * the provider's models up in the merged catalog and delegates to
 * {@link resolveReasoningSupport}, falling back to the heuristic when offline.
 */
export function modelSupportsReasoning(modelId: string, providerId?: string): Promise<boolean>;
export function modelSupportsReasoning(
  mOrId: CatalogModel | string,
  providerId?: string,
): boolean | Promise<boolean> {
  if (typeof mOrId === "string") {
    // Fast path: resolve the exact model without sorting the whole list. The
    // exact match short-circuits, so the (rare) full-list sort below only runs
    // when the model is absent from the resolved provider's catalog.
    if (providerId) {
      const exact = getModelsForProvider(providerId, mOrId);
      if (exact) return Promise.resolve(resolveReasoningSupport(mOrId, [exact]));
    }
    const models = providerId ? getModelsForProvider(providerId) : [];
    return Promise.resolve(resolveReasoningSupport(mOrId, models));
  }
  if (mOrId.reasoning) return true;
  return resolveReasoningSupport(mOrId.id, []);
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
