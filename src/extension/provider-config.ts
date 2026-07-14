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
import { resolveAndValidateLlmBaseUrl } from "../lib/agent/llm/route/ssrf";
import { modelSupportsVision, getDefaultModelForProvider } from "../lib/agent/llm/catalog";
import { CATALOG_PROVIDER_ID_MAP } from "./provider-config-map";

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
  /**
 * Provenance of this config's `baseUrl`. `"user"` = configured by the user
 * in Options (the curated local-provider loopback exemption applies).
 * `"injected"` = arrived via an untrusted vector (prompt injection writing
 * `chrome.storage.local`, malicious settings-sync, crafted tool call).
 * Injected baseUrls are NOT exempted from the SSRF guard (see below), so an
 * injected `http://localhost:11434` can't reach a local model. Defaults to
 * `"user"`.
 */
  provenance?: "user" | "injected";
}

// Import the canonical profile table from openai-compatible-profile.ts
// instead of maintaining a separate DEFAULT_BASE_URLS copy. The profiles table
// is the single source of truth for OpenAI-compatible provider base URLs.
import { profiles, byProvider } from "../lib/agent/llm/providers/openai-compatible-profile";

/**
 * Default base URLs — derived from the canonical profiles table.
 *
 * NOTE: `DEFAULT_BASE_URLS` is ONLY consulted by:
 * - the `default` (OpenAI-compatible) branch in `buildProvider`, which
 * synthesizes a profile for providers without a dedicated `case`
 * (deepseek, qwen, groq, ollama, ...);
 * - the dedicated `case "google"` branch (Vertex AI), which has no static
 * default URL and falls back to `DEFAULT_BASE_URLS["google"]` when the
 * user supplies no `baseUrl`.
 *
 * Providers that have their OWN dedicated `case` AND a static default in their
 * facade (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`, `azure`) never
 * read this map. So we deliberately exclude `openrouter` / `xai` from the
 * spread below (they'd be dead entries that look like they back the dedicated
 * cases but don't). `google` is intentionally NOT in the profiles table, so
 * it is absent here and the `case "google"` branch requires an explicit
 * `baseUrl` from the user (FULL-REVIEW finding 124 corrects the prior comment
 * that omitted google from the list of map readers).
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
 // Spread the profiles table entries (covers deepseek, groq, together, etc.)
 // — excluding `openrouter` / `xai`, which have dedicated `case` branches and
 // therefore never consult this map. Providers with a dedicated `case`
 // (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`, `azure`) are NOT
 // listed here on purpose: their default base URLs come from the provider
 // facades, so a dead entry here would be misleading and a regression risk if
 // a dedicated `case` ever regressed to the `default` branch. `google` is
 // handled separately by its own `case` branch and is intentionally absent
 // from this spread.
  ...Object.fromEntries(
    Object.values(profiles)
      .filter((p) => p.provider !== "openrouter" && p.provider !== "xai")
      .map((p) => [p.provider, p.baseURL]),
  ),
};

/**
 * The set of provider ids the extension knows how to build via `buildProvider`.
 *
 * Used ONLY for a defensive warning in `readProviderConfig`: if a corrupted or
 * injected `chrome.storage.local` payload carries a provider id we don't
 * recognise, we surface a dev warning here (so the anomaly is observable)
 * while still returning it, letting `buildProvider` reject it with a precise
 * "Unknown provider" error. It is not a security boundary.
 *
 * Forwards the canonical OpenAI-compatible profile ids (via `byProvider`) plus
 * the dedicated-case providers that have their own `switch` branch in
 * `buildProvider` (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`,
 * `azure`, `google`, `ollama`). Duplicates are harmless (it's a Set).
 */
export const KNOWN_PROVIDERS: Set<string> = new Set<string>([
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "openrouter",
  "azure",
  "google",
  "ollama",
  ...Object.keys(byProvider),
]);

/** Default models for each provider (used when the user doesn't specify one).
 * These are OFFLINE FALLBACK ONLY — the online default model is resolved from
 * the models.dev catalog via `getDefaultModelForProvider` (see `buildProvider`).
 * They don't appear in the profiles table because they change frequently.
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
  xai: "grok-2",
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
 * that require one — local providers like Ollama don't).
 */
export async function buildProvider(config: ProviderConfig): Promise<LLMProvider> {
  const { provider, apiKey, model, baseUrl, resourceName, provenance = "user" } = config;
 // Resolve the model: explicit user choice > live catalog default >
 // offline DEFAULT_MODELS fallback. `CATALOG_PROVIDER_ID_MAP` maps our
 // provider id (e.g. "gemini") to the models.dev catalog provider id
 // (e.g. "google") so `getDefaultModelForProvider` can find the newest
 // non-deprecated model. Falls back to "" if everything is unavailable.
  const catalogProviderId = CATALOG_PROVIDER_ID_MAP[provider] ?? provider;
  const resolvedModel =
    model ||
    (await getDefaultModelForProvider(catalogProviderId)) ||
    DEFAULT_MODELS[provider] ||
    "";

 // SSRF guard: reject a user-supplied `baseUrl` that points at a loopback /
 // private / link-local / cloud-metadata address. `baseUrl` is untrusted
 // input. The curated `DEFAULT_BASE_URLS` fallbacks (used only when the user
 // supplies no baseUrl) are trusted and exempted so Ollama/LiteLLM localhost
 // defaults keep working; they are not validated here.
 //
 // Provenance matters: a `"user"`-configured `baseUrl` may use the curated
 // local-provider exemption (their own Ollama/LiteLLM). An `"injected"`
 // baseUrl (from prompt injection / malicious settings-sync) is NOT exempted
 // — `resolveAndValidateLlmBaseUrl(... allowLocalExemption=false)` makes the
 // exemption unreachable, so an injected `http://localhost:11434` (or a
 // poisoned hostname resolving to 169.254.169.254) is blocked. The async
 // variant also DNS-resolves hostnames so poisoned-hostname SSRF is caught.
  if (baseUrl) {
    const allowLocalExemption = provenance === "user";
    const ssrf = await resolveAndValidateLlmBaseUrl(baseUrl, allowLocalExemption);
    if (!ssrf.ok) {
      throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${baseUrl} (${ssrf.reason})`);
    }
  }

  let result: LLMProvider;
  switch (provider) {
    case "openai":
      if (!apiKey) throw new Error("OpenAI requires an API key. Add one in Options.");
      result = OpenAI.toLLMProvider({
        apiKey,
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

    case "google": {
 // Google Vertex AI is reached through its OpenAI-compatible endpoint
 // (https://ai.googleapis.com/v1beta1/projects/{project}/locations/{loc}/...).
 // The project/location are specific to the user's GCP setup, so there is
 // no single static default URL — the user must supply `baseUrl` in
 // Options. Route through the OpenAICompatible facade once a baseUrl is
 // present.
      if (!apiKey) throw new Error("Google (Vertex AI) requires an API key. Add one in Options.");
      const resolvedBaseURL = baseUrl || DEFAULT_BASE_URLS["google"];
      if (!resolvedBaseURL) {
        throw new Error(
          "Google (Vertex AI) requires a baseUrl. Enter your Vertex OpenAI-compatible endpoint in Options (e.g. https://ai.googleapis.com/v1beta1/projects/…/locations/…/endpoints/openai)."
        );
      }
      result = OpenAICompatible.toLLMProvider({
        provider: "google",
        apiKey,
        model: resolvedModel,
        baseURL: resolvedBaseURL,
      });
      break;
    }

    default: {
 // A provider that isn't in `KNOWN_PROVIDERS` and isn't a recognized
 // openai-compatible alias is genuinely unknown. Report that precisely
 // instead of masking it behind the API-key check (which would otherwise
 // throw "${provider} requires an API key" for an unrecognized id,
 // hiding the real problem — FULL-REVIEW finding 53).
      if (!KNOWN_PROVIDERS.has(provider)) {
        throw new Error(
          `Unknown provider "${provider}". Pick one of: ${[...KNOWN_PROVIDERS].join(", ")}.`
        );
      }
      const needsKey = provider !== "ollama";
      if (needsKey && !apiKey) {
        throw new Error(`${provider} requires an API key. Add one in Options.`);
      }
      const resolvedBaseURL = baseUrl || DEFAULT_BASE_URLS[provider];
      if (!resolvedBaseURL && needsKey) {
        throw new Error(
          `Provider "${provider}" requires a baseUrl. Enter one in Options, or pick one of: ${Object.keys(byProvider).join(", ")}.`
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
 //
 // On catalog lookup failure, FAIL SAFE toward the more conservative vision
 // state (no screenshot gating) rather than silently trusting the hardcoded
 // per-provider flag — that flag is the unreliable value that caused the
 // screenshot-gating flip-flop bug (extractState skipped captureVisibleTab
 // while navigatorCallDirect tried to embed a non-existent screenshot).
 // We also persist a debug marker to `chrome.storage.local` so the failure
 // survives the production build (console.* is stripped), giving operators a
 // signal instead of an invisible revert to the unreliable flag.
  try {
    const visionCapable = await modelSupportsVision(resolvedModel, catalogProviderId);
    if (visionCapable !== result.supportsVision) {
      result = {
        ...result,
        supportsVision: visionCapable,
      };
    }
  } catch (catErr) {
    const reason = catErr instanceof Error ? catErr.message : String(catErr);
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        await chrome.storage.local.set({
          lastVisionCatalogFailure: {
            provider,
            model: resolvedModel,
            reason,
            at: Date.now(),
          },
        });
      } catch {
        /* storage may be unavailable — non-fatal */
      }
    }
    result = { ...result, supportsVision: false };
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
    "model",
    "baseUrl",
    "resourceName",
 // Legacy migration fallback only: the API key normally lives in
 // `chrome.storage.session`. Reading `apiKey` here lets upgraded installs
 // that still have the key in `local` (not yet migrated to session) work.
    "apiKey",
  ]);
 // The API key is persisted in `chrome.storage.session` (in-memory, never on
 // disk) for safety. Read it from there; fall back to `local` only for
 // not-yet-migrated installs. Never console.log the value.
  let apiKey = "";
  if (chrome.storage?.session) {
    const sres = await chrome.storage.session.get(["apiKey"]);
    apiKey = (sres.apiKey as string) || "";
  }
  if (!apiKey) apiKey = normalizeString(res.apiKey);
  const provider = normalizeString(res.provider);
  if (!provider) return null; // no provider set → unconfigured user
 // Defense-in-depth: a corrupted / injected `chrome.storage.local` payload
 // could carry an arbitrary provider id. We still return it so `buildProvider`
 // throws its precise "Unknown provider" error (the actionable message the UI
 // surfaces), but we log a warning here so the anomaly is observable in dev.
  if (!KNOWN_PROVIDERS.has(provider)) {
    console.warn(
      `[provider-config] Unknown provider "${provider}" read from storage; buildProvider will reject it.`
    );
  }
  const model = normalizeString(res.model);
  const baseUrl = normalizeString(res.baseUrl);
  const resourceName = normalizeString(res.resourceName);
  return {
    provider,
    apiKey,
    model,
    baseUrl: baseUrl || undefined,
    resourceName: resourceName || undefined,
    provenance: "user",
  };
}

/**
 * Coerce a stored value to a string. `chrome.storage` access returns `unknown`,
 * and a corrupted / coerced payload (e.g. a number or boolean from a buggy
 * synced-settings write) would otherwise flow through `as string` unchanged and
 * reach the provider constructors as the wrong type. Reject non-string values
 * explicitly (returning "") so downstream code always sees a real string.
 */
function normalizeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
