/**
 * Provider config — builds an {@link LLMProvider} directly from the user's
 * settings in `chrome.storage.local`. Used by the Chrome extension's background
 * worker so it can call LLM APIs DIRECTLY (no localhost backend required).
 *
 * The user configures their provider + API key + model in the extension's
 * Options page. This module reads that config and constructs the right provider
 * instance via the new Route-based provider facades in
 * `src/lib/agent/llm/providers/`.
 */

import type { LLMProvider } from "../lib/agent/llm/provider";
import * as OpenAI from "../lib/agent/llm/providers/openai";
import * as Anthropic from "../lib/agent/llm/providers/anthropic";
import * as Google from "../lib/agent/llm/providers/google";
import * as XAI from "../lib/agent/llm/providers/xai";
import * as OpenRouter from "../lib/agent/llm/providers/openrouter";
import * as Azure from "../lib/agent/llm/providers/azure";
import * as OpenAICompatible from "../lib/agent/llm/providers/openai-compatible";
import { modelSupportsVision } from "../lib/agent/llm/catalog";

/** The user's provider configuration (stored in chrome.storage.local). */
export interface ProviderConfig {
  /** Provider id: openai, anthropic, gemini, or any openai-compatible (deepseek, qwen, groq, ollama, ...). */
  provider: string;
  /** API key (the user's own — never hardcoded). */
  apiKey: string;
  /** Model name (e.g. "gpt-4o", "claude-3-5-sonnet", "gemini-2.0-flash"). */
  model: string;
  /** Base URL for OpenAI-compatible providers (DeepSeek, Qwen, Groq, Ollama, etc.). */
  baseUrl?: string;
  /** Azure resource name (optional — Azure URL is built as `https://{resource}.openai.azure.com`). */
  resourceName?: string;
}

// Import the canonical profile table from openai-compatible-profile.ts
// instead of maintaining a separate DEFAULT_BASE_URLS copy. The profiles table
// is the single source of truth for OpenAI-compatible provider base URLs.
import { profiles } from "../lib/agent/llm/providers/openai-compatible-profile";

/** Default base URLs — derived from the canonical profiles table. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  // Spread the profiles table entries (covers deepseek, groq, together, etc.)
  ...Object.fromEntries(Object.values(profiles).map((p) => [p.provider, p.baseURL])),
  // Add entries for non-OpenAI-compatible providers not in the profiles table:
};

/** Default models for each provider (used when the user doesn't specify one).
 * These are UI defaults, not protocol-level defaults — they don't appear in the
 * profiles table because they change frequently. Each name maps to an entry in
 * `PRICING_PER_MTOK` so cost tracking works out-of-the-box.
 *
 * Exported so `agent-bridge.ts` can apply the SAME default-model resolution
 * when computing `mainModelVision` — otherwise an empty `model` field would
 * disagree with the LLM-side check in `navigatorCallDirect()` (which uses
 * `provider.supportsVision` AFTER default resolution in `buildProvider`).
 * That disagreement caused the screenshot gating to flip-flop: extractState
 * thought "no vision" and skipped `captureVisibleTab`, while navigatorCallDirect
 * thought "vision" and tried to embed a non-existent screenshot. */
export const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet",
  gemini: "gemini-2.0-flash",
  deepseek: "deepseek-chat",
  qwen: "qwen-2.5-72b-instruct",
  groq: "llama-3.3-70b-versatile",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  mistral: "mistral-large-latest",
  cerebras: "llama3.1-70b",
  openrouter: "anthropic/claude-3-5-sonnet",
  ollama: "llama3.3",
  opencode: "",
  litellm: "gpt-4o",
  azure: "gpt-4o",
};

/**
 * Build an {@link LLMProvider} from the user's stored config. The provider calls
 * the LLM API directly via `fetch` — no localhost, no server, no env vars.
 *
 * After constructing the provider, patches `supportsVision` based on a per-MODEL
 * lookup against the models.dev catalog (with a heuristic name-based fallback
 * for models not in the catalog, e.g. local Ollama models). This is the CORRECT
 * per-model detection — the old hardcoded per-provider `supportsVision` couldn't
 * detect new vision models released after the code was written.
 *
 * @throws if the provider is unknown or the API key is missing (for providers
 *         that require one — local providers like Ollama don't).
 */
export async function buildProvider(config: ProviderConfig): Promise<LLMProvider> {
  const { provider, apiKey, model, baseUrl, resourceName } = config;
  const resolvedModel = model || DEFAULT_MODELS[provider] || "";

  let result: LLMProvider;
  switch (provider) {
    case "openai":
      result = OpenAI.toLLMProvider({
        apiKey: apiKey || undefined,
        model: resolvedModel,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
      break;

    case "anthropic":
      if (!apiKey) throw new Error("Anthropic requires an API key. Add one in Options.");
      result = Anthropic.toLLMProvider({ apiKey, model: resolvedModel });
      break;

    case "gemini":
      if (!apiKey) throw new Error("Gemini requires an API key. Add one in Options.");
      result = Google.toLLMProvider({ apiKey, model: resolvedModel });
      break;

    case "xai":
      if (!apiKey) throw new Error("xAI requires an API key. Add one in Options.");
      result = XAI.toLLMProvider({ apiKey, model: resolvedModel });
      break;

    case "openrouter":
      if (!apiKey) throw new Error("OpenRouter requires an API key. Add one in Options.");
      result = OpenRouter.toLLMProvider({
        apiKey,
        model: resolvedModel,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
      break;

    case "azure":
      if (!apiKey) throw new Error("Azure OpenAI requires an API key. Add one in Options.");
      result = Azure.toLLMProvider({
        apiKey,
        model: resolvedModel,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(resourceName ? { resourceName } : {}),
      });
      break;

    default: {
      const needsKey = provider !== "ollama";
      if (needsKey && !apiKey) {
        throw new Error(`${provider} requires an API key. Add one in Options.`);
      }
      const resolvedBaseURL = baseUrl || DEFAULT_BASE_URLS[provider];
      if (!resolvedBaseURL && needsKey) {
        throw new Error(
          `Unknown provider "${provider}". Supply a baseUrl in Options, or pick one of: ${[
            "openai", "anthropic", "gemini", "xai", "openrouter", "azure",
            "deepseek", "qwen", "groq", "together", "mistral", "cerebras",
            "ollama", "opencode", "litellm",
          ].join(", ")}.`
        );
      }
      result = OpenAICompatible.toLLMProvider({
        provider,
        apiKey: apiKey || undefined,
        model: resolvedModel,
        baseURL: resolvedBaseURL,
      });
      break;
    }
  }

  // Patch supportsVision based on per-MODEL detection. The provider facade's
  // hardcoded value is the fallback; the catalog lookup overrides it with
  // accurate per-model data. This catches new vision models (e.g. a Groq
  // vision model released after the code was written) that the hardcoded
  // per-provider flag would miss.
  try {
    const { CATALOG_PROVIDER_ID_MAP } = await import("./provider-config-map");
    const catalogProviderId = CATALOG_PROVIDER_ID_MAP[provider] ?? provider;
    const visionCapable = await modelSupportsVision(resolvedModel, catalogProviderId);
    if (visionCapable !== result.supportsVision) {
      result = {
        ...result,
        supportsVision: visionCapable,
      };
    }
  } catch {
    // Catalog lookup failed (offline, network error) — keep the provider's
    // hardcoded supportsVision.
  }

  return result;
}

/**
 * Read the provider config from `chrome.storage.local`. Returns null if the
 * provider hasn't been configured yet.
 */
export async function readProviderConfig(): Promise<ProviderConfig | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  const res = await chrome.storage.local.get([
    "provider",
    "apiKey",
    "model",
    "baseUrl",
  ]);
  const provider = (res.provider as string) || "";
  if (!provider) return null; // no provider set → unconfigured user
  const apiKey = (res.apiKey as string) || "";
  const model = (res.model as string) || "";
  const baseUrl = (res.baseUrl as string) || "";
  return { provider, apiKey, model, baseUrl: baseUrl || undefined };
}
