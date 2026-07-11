/**
 * options/providers.ts — single source of truth for the provider catalog.
 *
 * Replaces the previous three-way duplication:
 *   1. the hard-coded 14 `<option>`s in options.html,
 *   2. `PROVIDER_META` in provider-config-ui.ts,
 *   3. `CATALOG_PROVIDER_ID_MAP` in provider-config-map.ts (provider → models.dev id).
 *
 * Every surface that needs the provider list (the Connection-tab `<select>`,
 * `updateProviderUI` hints, the model-search catalog lookup) now reads from the
 * one `PROVIDERS` array below. Adding a provider means adding ONE entry here.
 *
 * The catalog id comes from `CATALOG_PROVIDER_ID_MAP` so the model-search and
 * runtime `buildProvider` stay in agreement with the dropdown.
 */

import { CATALOG_PROVIDER_ID_MAP } from "../provider-config-map";

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
 * The canonical, ordered provider list — ALL 16 supported providers.
 * Order is intentional: local-first, then the most popular, then the rest.
 */
export const PROVIDERS: ProviderDef[] = [
  { id: "ollama",     label: "Ollama (local)", catalogId: CATALOG_PROVIDER_ID_MAP.ollama,     hint: "Ollama — local, free. Run `ollama pull <model>` first.", defaultModel: "llama3.3", defaultBaseUrl: "http://localhost:11434/v1", needsKey: false, keyPlaceholder: "ollama", keyUrl: "https://ollama.com" },
  { id: "opencode",   label: "OpenCode",        catalogId: CATALOG_PROVIDER_ID_MAP.opencode,   hint: "OpenCode — connect any of 75+ LLM providers via OpenCode.", defaultModel: "", defaultBaseUrl: "https://opencode.ai/api/v1", needsKey: true, keyPlaceholder: "your-opencode-key", keyUrl: "https://opencode.ai/docs/providers" },
  { id: "openai",     label: "OpenAI",          catalogId: CATALOG_PROVIDER_ID_MAP.openai,     hint: "OpenAI — GPT-4o, o-series, GPT-4.1 models.", defaultModel: "gpt-4o", needsKey: true, keyPlaceholder: "sk-proj-...", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic",  label: "Anthropic",       catalogId: CATALOG_PROVIDER_ID_MAP.anthropic,  hint: "Anthropic — Claude 3.5 Sonnet, Opus, Haiku.", defaultModel: "claude-3-5-sonnet", needsKey: true, keyPlaceholder: "sk-ant-api03-...", keyUrl: "https://console.anthropic.com/" },
  { id: "gemini",     label: "Google Gemini",   catalogId: CATALOG_PROVIDER_ID_MAP.gemini,     hint: "Google Gemini — Pro, Flash, 2.0/2.5 series (Google AI Studio).", defaultModel: "gemini-2.0-flash", needsKey: true, keyPlaceholder: "AIza...", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "google",     label: "Google (Vertex)", catalogId: CATALOG_PROVIDER_ID_MAP.google,     hint: "Google Vertex AI — enterprise Gemini access.", defaultModel: "gemini-2.0-flash", needsKey: true, keyPlaceholder: "AIza...", keyUrl: "https://console.cloud.google.com/vertex-ai" },
  { id: "deepseek",   label: "DeepSeek",        catalogId: CATALOG_PROVIDER_ID_MAP.deepseek,   hint: "DeepSeek — chat, reasoner (V3, R1).", defaultModel: "deepseek-chat", defaultBaseUrl: "https://api.deepseek.com/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://platform.deepseek.com" },
  { id: "qwen",       label: "Qwen / Alibaba",  catalogId: CATALOG_PROVIDER_ID_MAP.qwen,       hint: "Qwen / Alibaba — qwen-2.5-72b, qwen-vl-max.", defaultModel: "qwen-2.5-72b-instruct", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://dashscope.aliyuncs.com" },
  { id: "groq",       label: "Groq",            catalogId: CATALOG_PROVIDER_ID_MAP.groq,       hint: "Groq — ultra-fast Llama/Mixtral inference.", defaultModel: "llama-3.3-70b-versatile", defaultBaseUrl: "https://api.groq.com/openai/v1", needsKey: true, keyPlaceholder: "gsk_...", keyUrl: "https://console.groq.com" },
  { id: "together",   label: "Together AI",     catalogId: CATALOG_PROVIDER_ID_MAP.together,   hint: "Together AI — open-source models.", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", defaultBaseUrl: "https://api.together.xyz/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://api.together.xyz" },
  { id: "mistral",    label: "Mistral",         catalogId: CATALOG_PROVIDER_ID_MAP.mistral,    hint: "Mistral — Mistral Large, Codestral, Pixtral.", defaultModel: "mistral-large-latest", defaultBaseUrl: "https://api.mistral.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://console.mistral.ai" },
  { id: "cerebras",   label: "Cerebras",        catalogId: CATALOG_PROVIDER_ID_MAP.cerebras,   hint: "Cerebras — ultra-fast inference.", defaultModel: "llama3.1-70b", defaultBaseUrl: "https://api.cerebras.ai/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://cerebras.ai" },
  { id: "openrouter", label: "OpenRouter",      catalogId: CATALOG_PROVIDER_ID_MAP.openrouter, hint: "OpenRouter — 300+ models (provider/model format).", defaultModel: "anthropic/claude-3-5-sonnet", defaultBaseUrl: "https://openrouter.ai/api/v1", needsKey: true, keyPlaceholder: "sk-or-v1-...", keyUrl: "https://openrouter.ai" },
  { id: "litellm",    label: "LiteLLM proxy",   catalogId: CATALOG_PROVIDER_ID_MAP.litellm,    hint: "LiteLLM — universal proxy.", defaultModel: "gpt-4o", defaultBaseUrl: "http://localhost:4000/v1", needsKey: true, keyPlaceholder: "...", keyUrl: "https://github.com/BerriAI/litellm" },
  { id: "azure",      label: "Azure OpenAI",    catalogId: CATALOG_PROVIDER_ID_MAP.azure,      hint: "Azure OpenAI — use your deployed model name.", defaultModel: "gpt-4o", defaultBaseUrl: "https://your-resource.openai.azure.com", needsKey: true, keyPlaceholder: "...", keyUrl: "https://portal.azure.com" },
  { id: "xai",        label: "xAI (Grok)",      catalogId: CATALOG_PROVIDER_ID_MAP.xai,        hint: "xAI — Grok models.", defaultModel: "grok-2", defaultBaseUrl: "https://api.x.ai/v1", needsKey: true, keyPlaceholder: "xai-...", keyUrl: "https://x.ai/api" },
];

/** Record keyed by provider id — drop-in replacement for the old `PROVIDER_META`. */
export const PROVIDER_META: Record<string, ProviderDef> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

/** Just the provider ids, in display order. */
export const PROVIDER_IDS: string[] = PROVIDERS.map((p) => p.id);

/** The provider metadata used as the implicit default when a saved id is unknown. */
export const DEFAULT_PROVIDER_ID = "openai";

/**
 * Look up a provider's catalog id for the model-search query. Returns
 * `undefined` for any provider id that is not present in the catalog map
 * (i.e. providers that have no model search). Every id in `PROVIDERS` is a key
 * of `CATALOG_PROVIDER_ID_MAP`, so this is a direct, exhaustive lookup.
 */
export function catalogIdFor(providerId: string): string | undefined {
  return CATALOG_PROVIDER_ID_MAP[providerId];
}
