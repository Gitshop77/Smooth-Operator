/**
 * DEPRECATED — provider-ID → models.dev catalog provider-ID map.
 *
 * This file exists only as a shim to dodge a circular import
 * (agent-bridge.ts → provider-config.ts → llm-direct.ts). That cycle is a
 * symptom of misplaced responsibilities; the natural owner of this metadata is
 * `src/lib/agent/llm/catalog.ts` (which sits below both consumers) or, once the
 * provider catalog is consolidated, a `catalogId` field on each `ProviderDef` in
 * `options/providers.ts`.
 *
 * Consolidation plan:
 * 1. Define the map inside `src/lib/agent/llm/catalog.ts` (or derive it via
 * `Object.fromEntries(PROVIDERS.map(p => [p.id, p.catalogId]))` from
 * `options/providers.ts`).
 * 2. Have `provider-config.ts` and `agent-bridge.ts` import from that owner.
 * 3. Delete THIS file.
 *
 * Do NOT add new providers here without also updating `options/providers.ts`;
 * the two sources must stay in sync until the map is deleted, otherwise model
 * search silently breaks for the new provider.
 *
 * Used by `provider-config.ts` (in buildProvider), `options/providers.ts`
 * (model-search catalog IDs), and `background/run-helpers.ts` (vision gating)
 * to look up per-model vision capability.
 */

/** Map our provider IDs to models.dev catalog provider IDs. */
export const CATALOG_PROVIDER_ID_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  google: "google",
  deepseek: "deepseek",
  groq: "groq",
  together: "togetherai",
  mistral: "mistral",
  cerebras: "cerebras",
  openrouter: "openrouter",
  xai: "xai",
  ollama: "ollama",
  qwen: "alibaba",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  litellm: "litellm",
  azure: "openai", // Azure uses OpenAI models
};
