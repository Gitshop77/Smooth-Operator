/**
 * Shared provider-ID → models.dev catalog provider-ID map.
 *
 * Used by both `provider-config.ts` (in buildProvider) and `agent-bridge.ts`
 * (in the extractState callback) to look up per-model vision capability.
 * Keeping it in a separate file avoids a circular import between
 * agent-bridge.ts → provider-config.ts → llm-direct.ts.
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
  qwen: "dashscope",
  opencode: "opencode",
  litellm: "litellm",
  azure: "openai", // Azure uses OpenAI models
};
