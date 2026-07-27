/**
 * options/providers.ts — the recognized facade/profile set (the visible provider
 * dropdown is generated from the bundled models.dev catalog, not from this list).
 *
 * Replaces the previous three-way duplication:
 * 1. the hard-coded 14 `<option>`s in options.html,
 * 2. `PROVIDER_META` in provider-config-ui.ts,
 * 3. `CATALOG_PROVIDER_ID_MAP` in provider-config-map.ts (provider → models.dev id).
 *
 * Every surface that needs the provider list (the Connection-tab `<select>`,
 * `updateProviderUI` hints, the model-search catalog lookup) now reads from the
 * one `PROVIDERS` array below. Adding a provider means adding ONE entry here.
 *
 * The catalog id comes from `CATALOG_PROVIDER_ID_MAP` so the model-search and
 * runtime `buildProvider` stay in agreement with the dropdown.
 */

import { CATALOG_PROVIDER_ID_MAP } from "../provider-config-map";
import { getProvider, getDefaultModelForProvider, getProviders } from "../../lib/agent/llm/catalog";

/** A single provider's display + connection metadata. */
export interface ProviderDef {
  /** Stable provider id (matches the `provider` storage key + buildProvider switch). */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** models.dev catalog id (undefined → no model search for this provider). */
  catalogId: string | undefined;
  /** Hint shown below the provider dropdown. */
  hint: string;
  /** Default model name (used as placeholder / fallback). */
  defaultModel: string;
  /** Default base URL (OpenAI-compatible providers only). */
  defaultBaseUrl?: string;
  /** Whether this provider requires an API key (local ones don't). */
  needsKey: boolean;
  /** API key placeholder. */
  keyPlaceholder: string;
  /** Where to get an API key. */
  keyUrl: string;
}

/**
 * The recognized facade/profile set — the dedicated and OpenAI-compatible
 * providers the extension knows how to build a client for. This is NOT the
 * visible Options dropdown: that list is generated from the bundled models.dev
 * catalog (every provider with an `api` endpoint, plus these). New providers in
 * the catalog appear automatically without editing this list.
 * Order is intentional: local-first, then the most popular, then the rest.
 */
/**
 * Featured providers — the curated, hand-ordered set shown first in the
 * dropdown. Their `id`s are the UI/storage provider ids that `buildProvider`'s
 * switch (in `provider-config.ts`) and `CATALOG_PROVIDER_ID_MAP` understand.
 * Order is intentional: local-first, then the most popular, then the rest.
 */
export const FEATURED_PROVIDERS: ProviderDef[] = [
  { id: "ollama",     label: "Ollama (local)", catalogId: CATALOG_PROVIDER_ID_MAP.ollama,     hint: "Ollama — local, free. Run `ollama pull <model>` first.", defaultModel: "llama3.3", defaultBaseUrl: "http://localhost:11434/v1", needsKey: false, keyPlaceholder: "ollama", keyUrl: "https://ollama.com" },
  { id: "opencode",   label: "OpenCode Zen",    catalogId: CATALOG_PROVIDER_ID_MAP.opencode,   hint: "OpenCode Zen — curated models (GPT, Claude, Gemini, Grok, DeepSeek). All models use /chat/completions.", defaultModel: "", defaultBaseUrl: "https://opencode.ai/zen/v1/chat/completions", needsKey: true, keyPlaceholder: "your-opencode-zen-key", keyUrl: "https://opencode.ai/docs/providers/zen" },
  { id: "opencode-go", label: "OpenCode Go",    catalogId: CATALOG_PROVIDER_ID_MAP["opencode-go"], hint: "OpenCode Go — budget-friendly models (Grok, GLM, Kimi, DeepSeek, Qwen). All models use /chat/completions.", defaultModel: "", defaultBaseUrl: "https://opencode.ai/zen/go/v1/chat/completions", needsKey: true, keyPlaceholder: "your-opencode-go-key", keyUrl: "https://opencode.ai/docs/providers/zen" },
  { id: "openai",     label: "OpenAI",          catalogId: CATALOG_PROVIDER_ID_MAP.openai,     hint: "OpenAI — GPT-5.6 (Sol/Terra/Luna), GPT-5.5, o3, o4-mini.", defaultModel: "gpt-5.5", needsKey: true, keyPlaceholder: "sk-proj-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic",  label: "Anthropic",       catalogId: CATALOG_PROVIDER_ID_MAP.anthropic,  hint: "Anthropic — Claude Fable 5, Opus 5, Sonnet 5, Haiku 4.5. Note: temperature deprecated on 4.7+.", defaultModel: "claude-sonnet-5", needsKey: true, keyPlaceholder: "sk-ant-api03-...", keyUrl: "https://console.anthropic.com/" },
  { id: "gemini",     label: "Google Gemini",   catalogId: CATALOG_PROVIDER_ID_MAP.gemini,     hint: "Google Gemini — Gemini 3.6 Flash, 3.5 Flash / Pro (Google AI Studio).", defaultModel: "gemini-3.5-flash", needsKey: true, keyPlaceholder: "AIza...", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "google",     label: "Google (Vertex)", catalogId: CATALOG_PROVIDER_ID_MAP.google,     hint: "Google Vertex AI — enterprise Gemini 3.5 Flash/Pro (Vertex AI).", defaultModel: "gemini-3.5-flash", needsKey: true, keyPlaceholder: "AIza...", keyUrl: "https://console.cloud.google.com/vertex-ai" },
  { id: "deepseek",   label: "DeepSeek",        catalogId: CATALOG_PROVIDER_ID_MAP.deepseek,   hint: "DeepSeek — V4 Flash (chat, thinking, tools).", defaultModel: "deepseek-v4-flash", defaultBaseUrl: "https://api.deepseek.com", needsKey: true, keyPlaceholder: "...", keyUrl: "https://platform.deepseek.com" },
  { id: "qwen",       label: "Qwen / Alibaba",  catalogId: CATALOG_PROVIDER_ID_MAP.qwen,       hint: "Qwen / Alibaba — Qwen3.6 / Qwen3.7 (Max, Plus, Coder, VL).", defaultModel: "qwen3.7-max", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://dashscope.aliyuncs.com" },
  { id: "groq",       label: "Groq",            catalogId: CATALOG_PROVIDER_ID_MAP.groq,       hint: "Groq — ultra-fast Llama / open-model inference.", defaultModel: "llama-3.3-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1", needsKey: true, keyPlaceholder: "gsk_...", keyUrl: "https://console.groq.com" },
  { id: "together",   label: "Together AI",     catalogId: CATALOG_PROVIDER_ID_MAP.together,   hint: "Together AI — Llama, Qwen, DeepSeek and other open models.", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", defaultBaseUrl: "https://api.together.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://api.together.ai" },
  { id: "mistral",    label: "Mistral",         catalogId: CATALOG_PROVIDER_ID_MAP.mistral,    hint: "Mistral — Small 4, Medium 3.5, Devstral, Ministral 3.", defaultModel: "mistral-small-latest", defaultBaseUrl: "https://api.mistral.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://console.mistral.ai" },
  { id: "cerebras",   label: "Cerebras",        catalogId: CATALOG_PROVIDER_ID_MAP.cerebras,   hint: "Cerebras — ultra-fast open-model inference (Llama, GPT-OSS).", defaultModel: "gpt-oss-120b", defaultBaseUrl: "https://api.cerebras.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://cerebras.ai" },
  { id: "openrouter", label: "OpenRouter",      catalogId: CATALOG_PROVIDER_ID_MAP.openrouter, hint: "OpenRouter — 300+ models (provider/model format, e.g. anthropic/claude-sonnet-5).", defaultModel: "anthropic/claude-sonnet-5", defaultBaseUrl: "https://openrouter.ai/api/v1", needsKey: true, keyPlaceholder: "sk-or-v1-...", keyUrl: "https://openrouter.ai" },
  { id: "litellm",    label: "LiteLLM proxy",   catalogId: CATALOG_PROVIDER_ID_MAP.litellm,    hint: "LiteLLM — universal proxy (any upstream model).", defaultModel: "gpt-5.5", defaultBaseUrl: "http://localhost:4000/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://github.com/BerriAI/litellm" },
  { id: "azure",      label: "Azure OpenAI",    catalogId: CATALOG_PROVIDER_ID_MAP.azure,      hint: "Azure OpenAI — use your deployed model deployment name.", defaultModel: "gpt-5.5", defaultBaseUrl: "https://your-resource.openai.azure.com", needsKey: true, keyPlaceholder: "...", keyUrl: "https://portal.azure.com" },
  { id: "xai",        label: "xAI (Grok)",      catalogId: CATALOG_PROVIDER_ID_MAP.xai,        hint: "xAI — Grok 4.5 (flagship), Grok 4.3, Grok-Build.", defaultModel: "grok-4.3", defaultBaseUrl: "https://api.x.ai/v1", needsKey: true, keyPlaceholder: "xai-...", keyUrl: "https://x.ai/api" },
];

/**
 * Catalog-derived providers — every models.dev provider that exposes an
 * OpenAI-compatible `api` endpoint and is NOT already covered by a featured
 * entry gets a generated `ProviderDef` keyed by its catalog id. `buildProvider`'s
 * `default` branch builds a runtime facade for these via `catalog[id].api`, so
 * the ENTIRE dataset is selectable without a hard-coded case per provider.
 *
 * `coveredCatalogIds` dedupes featured providers that resolve to a catalog id
 * other than their own UI id (qwen→alibaba, together→togetherai,
 * gemini/google→google, azure→openai) so the same provider never appears twice.
 */
const FEATURED_IDS = new Set(FEATURED_PROVIDERS.map((p) => p.id));
const coveredCatalogIds = new Set(
  FEATURED_PROVIDERS.map((p) => p.catalogId).filter(Boolean) as string[],
);

const CATALOG_DERIVED_PROVIDERS: ProviderDef[] = getProviders()
  .filter(
    (p) =>
      p.api &&
      // Skip providers already represented by a featured entry (matched by
      // either their catalog id or their featured UI id), so the same provider
      // never appears twice even if a future dataset adds an `api` to a provider
      // whose id collides with a featured UI id (e.g. "azure", "google").
      !coveredCatalogIds.has(p.id) &&
      !FEATURED_IDS.has(p.id),
  )
  .map((p) => ({
    id: p.id,
    label: p.name,
    catalogId: p.id,
    hint: `${p.name} — ${Object.keys(p.models).length} models in catalog`,
    defaultModel: getDefaultModelForProvider(p.id),
    defaultBaseUrl: p.api,
    // A catalog `env` list means the provider needs an API key. When the catalog
    // omits `env` we conservatively assume a key is required (don't advertise a
    // keyless provider unless the catalog explicitly says so).
    needsKey: p.env ? p.env.length > 0 : true,
    keyPlaceholder: p.env?.[0] ?? "your-api-key",
    keyUrl: p.doc ?? "#",
  }))
  // Sort the long tail alphabetically for a predictable dropdown.
  .sort((a, b) => a.label.localeCompare(b.label));

/**
 * The provider list backing the Options dropdown: featured first (curated
 * order), then the full catalog tail (alphabetical). New dataset providers
 * appear automatically — no manual entry needed.
 */
export const PROVIDERS: ProviderDef[] = [
  ...FEATURED_PROVIDERS,
  ...CATALOG_DERIVED_PROVIDERS,
];

/** Record keyed by provider id — drop-in replacement for the old `PROVIDER_META`. */
export const PROVIDER_META: Record<string, ProviderDef> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

// Dev guard: every provider in `PROVIDERS` must resolve to a catalog id that
// ACTUALLY exists in the bundle — via `CATALOG_PROVIDER_ID_MAP` (featured
// providers whose UI id differs from their catalog id) or by being a catalog id
// itself (the generated dataset tail). Checking the RESOLVED id (not just that
// the UI id is present in the map) would have caught the old `qwen → "dashscope"`
// mapping pointing at a non-existent provider. Catch this drift at load instead
// of debugging a mysteriously empty model dropdown later.
// Providers that are intentionally NOT in the models.dev catalog (local or
// proxy facades). Their `catalogId` equals their own id, which is not a catalog
// provider — that's expected, so the guard stays silent for them and only
// flags a genuinely broken mapping (e.g. a `CATALOG_PROVIDER_ID_MAP` value that
// points at a provider that doesn't exist).
const INTENTIONAL_NON_CATALOG = new Set(["ollama", "litellm"]);

for (const p of PROVIDERS) {
  if (INTENTIONAL_NON_CATALOG.has(p.id)) continue;
  const resolved = CATALOG_PROVIDER_ID_MAP[p.id] ?? p.id;
  if (!getProvider(resolved)) {
    console.warn("[providers] provider", p.id, "resolves to unknown catalog id", resolved);
  }
}

/** The provider metadata used as the implicit default when a saved id is unknown. */
export const DEFAULT_PROVIDER_ID = "openai";

/**
 * Look up a provider's catalog id for the model-search query. Resolves:
 *  - a featured UI id via `CATALOG_PROVIDER_ID_MAP` (qwen→alibaba, …);
 *  - a catalog-id provider (the generated dataset tail) to itself;
 *  - anything else to `undefined` (no model search for that provider).
 */
export function catalogIdFor(providerId: string): string | undefined {
  const mapped = CATALOG_PROVIDER_ID_MAP[providerId];
  if (mapped) return mapped;
  return getProvider(providerId) ? providerId : undefined;
}
