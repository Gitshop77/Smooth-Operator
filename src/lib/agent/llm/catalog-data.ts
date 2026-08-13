/**
 * models.dev catalog — types, constants, validation, and merge logic
 * for the model/provider registry.
 *
 * This module contains pure data definitions, shape validation, and
 * deterministic merge logic with no mutable runtime state or I/O.
 */

/* ============================================================= *
 * Authoritative types (Agent A's bundle conforms to these).    *
 * ============================================================= */

/**
 * Effort levels a provider accepts for a reasoning model. `null` means the
 * provider accepts disabling reasoning explicitly (mirrors the models.dev SDK's
 * `ReasoningEffort`).
 */
export type ReasoningEffort =
  | null
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "default";

/**
 * Variant descriptors for a model's reasoning configuration (models.dev
 * `reasoning_options`): an effort list, an on/off toggle, and/or a thinking
 * budget token range. Each model may declare any subset of these.
 */
export type ReasoningOption =
  | { type: "effort"; values: ReasoningEffort[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number };

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
  /** Reasoning variant surface (drives the options UI effort/toggle/budget fields). */
  reasoning_options?: ReasoningOption[];
  limit?: { context: number; input?: number; output: number };
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
    input_audio?: number;
    output_audio?: number;
    /** Context-tier rates — the highest tier whose `size` is below the prompt's
     * context-token count applies (models.dev `CostTier`, type pinned to "context"). */
    tiers?: Array<{
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
      tier: { type: "context"; size: number };
    }>;
    /** Rates applied when the prompt exceeds 200k context tokens and no tier matches. */
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
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
 * Constants.                                                    *
 * ============================================================= */

import { providers as BUNDLED_CATALOG } from "@opencode-ai/models/snapshot";

export { BUNDLED_CATALOG };

export const CATALOG_URL = "https://models.dev/api.json";
// Storage keys are the one namespace users may see; keep this on the
// project's `open_cowork_` convention (the old `__opencowork_` prefix
// diverged — cached values self-heal via TTL revalidation after the rename).
export const CACHE_KEY = "open_cowork_models_dev_catalog";
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The reasoning variant options for a model, read from the BUNDLED snapshot
 * record (models.dev `reasoning_options`). Returns `[]` when the provider or
 * model is unknown, or when the model declares no variant descriptors. Pure —
 * no I/O, no dependence on the merged cache, so it works before any catalog
 * load. `providerId` is the models.dev catalog provider id.
 */
export function reasoningOptionsFor(modelId: string, providerId: string): ReasoningOption[] {
  return BUNDLED_CATALOG[providerId]?.models[modelId]?.reasoning_options ?? [];
}

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
export const VISION_PATTERNS: RegExp[] = [
  /\bvision\b/i,
  /\bvl\b/i,
  /\bllava\b/i,
  /\bbakllava\b/i,
  /\bmoondream\b/i,
  /\bminicpm\b/i,
  /\bpixtral\b/i,
  /\bflorence\b/i,
  /\bcogvlm\b/i,
  /\bqwen(?:3[._ -]?5)?[-_ ]*35b[-_ ]*a3b\b/i,
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
export const REASONING_PATTERNS: RegExp[] = [
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

export interface CachedCatalog {
  data: Catalog;
  fetchedAt: number;
}

/** Validate a single provider entry within a catalog. */
function isValidProvider(entry: unknown): entry is CatalogProvider {
  if (!entry || typeof entry !== "object") return false;
  const provider = entry as Record<string, unknown>;
  if (typeof provider.id !== "string" || typeof provider.name !== "string") return false;
  if (!provider.models || typeof provider.models !== "object") return false;
  for (const model of Object.values(provider.models as Record<string, unknown>)) {
    if (!isValidModel(model)) return false;
  }
  return true;
}

/** Validate a single model entry within a provider. */
function isValidModel(model: unknown): model is CatalogModel {
  if (!model || typeof model !== "object") return false;
  const m = model as Record<string, unknown>;
  if (
    typeof m.id !== "string" ||
    typeof m.name !== "string" ||
    typeof m.release_date !== "string"
  ) return false;
  if (m.cost !== undefined) {
    const c = m.cost as Record<string, unknown>;
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
      v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
    if (
      !rateOk(c.cache_read) ||
      !rateOk(c.cache_write) ||
      !rateOk(c.reasoning) ||
      !rateOk(c.input_audio) ||
      !rateOk(c.output_audio)
    ) return false;
  }
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
  return true;
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
    if (!isValidProvider(entry)) return false;
  }
  return true;
}

/* ============================================================= *
 * Merge (deterministic; no I/O or mutable state).              *
 * ============================================================= */

/**
 * Merge `live` OVER `base`. Bundled providers/models are never dropped
 * (additive); for any provider or model id present in both, the live entry
 * wins. Returns a fresh `Catalog` (no mutation of the inputs).
 */
export function mergeCatalogs(base: Catalog, live: Catalog): Catalog {
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
  return Object.freeze(out);
}
