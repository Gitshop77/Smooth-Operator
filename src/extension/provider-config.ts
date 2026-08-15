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
import { makeOpenAIChatFacade } from "../lib/agent/llm/providers/openai";
import * as OpenAICompatibleChat from "../lib/agent/llm/protocols/openai-compatible-chat";
import { resolveAndValidateLlmBaseUrl, type SsrfProvenance } from "../lib/agent/llm/route/ssrf";
import { redactUrl } from "../lib/agent/llm/route/url-redact";
import { modelSupportsVision, modelSupportsReasoning, getDefaultModelForProvider, resolveVisionSupport, fetchCatalog } from "../lib/agent/llm/catalog";
import { CATALOG_PROVIDER_ID_MAP } from "./provider-config-map";
import { ensureApiKeyInSession } from "./api-key-storage";

/** The user's provider configuration (stored in chrome.storage.local). */
export interface ProviderConfig {
  /** Provider id: openai, anthropic, gemini, or any openai-compatible (deepseek, qwen, groq, ollama, ...). */
  provider: string;
  /** API key (the user's own — never hardcoded). */
  apiKey: string;
  /** Model name (e.g. "gpt-5.5", "anthropic/claude-sonnet-5", "gemini-3.5-flash"). */
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

import { byProvider } from "../lib/agent/llm/providers/openai-compatible-profile";
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  defaultModelPriority,
  canonicalLlmHost,
  isLocalUrl,
} from "./provider-config-utils";

export { DEFAULT_MODELS } from "./provider-config-utils";

/**
 * The set of provider ids the extension knows how to build via `buildProvider`.
 *
 * Used ONLY for a defensive warning in `readProviderConfig`: if a corrupted or
 * injected `chrome.storage.local` payload carries a provider id we don't
 * recognise, we surface a dev warning here (so the anomaly is observable)
 * before falling back to the default provider (`openai`) with a
 * `provider_reset_warning` flag the UI surfaces. It is not a security boundary.
 *
 * Forwards the canonical OpenAI-compatible profile ids (via `byProvider`) plus
 * the dedicated-case providers that have their own `switch` branch in
 * `buildProvider` (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`,
 * `azure`, `google`, `ollama`). Duplicates are harmless (it's a Set).
 */
const KNOWN_PROVIDERS: Set<string> = new Set<string>([
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



/**
 * Resolve the effective model id for a provider config.
 *
 * Order (the SAME order `buildProvider` uses): explicit user choice (`model`)
 * > curated offline `DEFAULT_MODELS` fallback (keyed by the CATALOG provider id)
 * > family priority (live catalog, `defaultModelPriority`) > newest-stable
 * catalog default (`getDefaultModelForProvider`) > `""`.
 *
 * Centralised here so `extractStateForRun` (run-helpers.ts) can apply this exact
 * resolution instead of re-deriving it with a DIFFERENT order — a mismatch that
 * caused the screenshot-gating flip-flop bug (vision gating was computed against
 * a different model than the one actually used).
 *
 * `catalogId` is the models.dev catalog provider id (e.g. "google" for gemini,
 * "openai" for azure); pass it in when already computed. Otherwise `provider` is
 * used as the fallback key.
 */
export function resolveModel(config: { provider?: string; model?: string; catalogId?: string }): string {
  const pid = config.catalogId ?? config.provider ?? "";
  return (
    config.model ||
    DEFAULT_MODELS[pid] ||
    getDefaultModelForProvider(pid, defaultModelPriority[pid]) ||
    ""
  );
}

/** Throw the canonical "requires an API key" error when `apiKey` is empty. */
function requireApiKey(label: string, apiKey: string | undefined): void {
  if (!apiKey) throw new Error(`${label} requires an API key. Add one in Options.`);
}

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
 // Resolve the model via the shared `resolveModel` helper so the order matches
 // `extractStateForRun` exactly (no flip-flop). `CATALOG_PROVIDER_ID_MAP` maps
 // our provider id (e.g. "gemini") to the models.dev catalog provider id
 // (e.g. "google") so the DEFAULT_MODELS key and `getDefaultModelForProvider`
 // agree; it is passed as `catalogId` to keep the helper's pid consistent.
  const catalogProviderId = CATALOG_PROVIDER_ID_MAP[provider] ?? provider;
  const resolvedModel = resolveModel({ provider, model, catalogId: catalogProviderId });

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
    // Map ProviderConfig provenance ("user" | "injected") to SSRF provenance
    // ("user-configured" | "untrusted") so the DNS-unavailable allow path triggers.
    const ssrfProvenance: SsrfProvenance = provenance === "user" ? "user-configured" : "untrusted";
    const ssrf = await resolveAndValidateLlmBaseUrl(baseUrl, allowLocalExemption, ssrfProvenance);
    if (!ssrf.ok) {
      throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrl(baseUrl)} (${ssrf.reason})`);
    }

  }

  // Companion guard against API-key exfiltration (ADDITIVE — does not weaken
  // the SSRF guard above). The SSRF guard only blocks private/loopback/metadata
  // ranges, so a public attacker host still passes and would receive the user's
  // API key as a Bearer token. The stored `provenance` flag is NOT a safe trust
  // signal here: `chrome.storage.local` is attacker-writable (prompt injection,
  // malicious settings-sync, crafted tool call), so a hostile write can stamp
  // `provenance: "user"` on a public attacker host and — under the old behavior
  // — skip this check and exfiltrate the key. The loopback exemption governed by
  // the SSRF guard above only affects LOCAL endpoints (an injected loopback is
  // rejected; a user loopback is the legitimate Ollama/LiteLLM case), so for any
  // PUBLIC baseUrl we always confine the forwarded host to the provider's own
  // canonical host. Local endpoints keep the curated exemption and are excluded
  // from this check.
  if (baseUrl && (apiKey || provenance === "injected")) {
    // A local/loopback/RFC1918 endpoint is governed by the SSRF loopback
    // exemption above (an injected loopback is rejected; a user loopback is the
    // legitimate Ollama/LiteLLM case), so it is excluded from this check.
    // When no API key is present, host confinement still applies to an INJECTED
    // config: a keyless public attacker host has no secret to steal, but every
    // forwarded request would exfiltrate page data (task text, screenshots) to
    // the attacker, so the forwarded host is confined regardless of apiKey.
    // The SSRF guard above still blocks metadata/private/link-local targets.
    const isLocalEndpoint = isLocalUrl(baseUrl);
    if (!isLocalEndpoint) {
      const canon = canonicalLlmHost(provider, provenance);
      let hostname = "";
      try { hostname = new URL(baseUrl).hostname; } catch { hostname = ""; }
      // Suffix canonical hosts require a DOTTED subdomain boundary: an exact
      // match or `*.canon.host`. A bare `endsWith` would let an attacker host
      // like `evil-anthropic.com` (or `not-anthropic.com`) masquerade as the
      // provider and receive the user's API key as a Bearer token. The
      // comparison uses the HOSTNAME (port stripped) so a legit non-default
      // port on the canonical host is not rejected.
      const allowed =
        canon !== null &&
        (canon.suffix
          ? hostname === canon.host || hostname.endsWith("." + canon.host)
          : hostname === canon.host);
      if (!allowed) {
        throw new Error(
          `LLM baseUrl rejected: ${redactUrl(baseUrl)} is not the canonical host for provider "${provider}". ` +
            `To protect your API key from exfiltration, the baseUrl must target the provider's own host.`
        );
      }
    }
  }

  let result: LLMProvider;
  switch (provider) {
    case "openai":
      requireApiKey("OpenAI", apiKey);
      result = OpenAI.toLLMProvider({
        apiKey,
        model: resolvedModel,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        allowLocalExemption: provenance === "user",
      });
      break;

    case "anthropic":
      requireApiKey("Anthropic", apiKey);
      result = Anthropic.toLLMProvider({ apiKey, model: resolvedModel, allowLocalExemption: provenance === "user" });
      break;

    case "gemini":
      requireApiKey("Gemini", apiKey);
      result = Google.toLLMProvider({ apiKey, model: resolvedModel, allowLocalExemption: provenance === "user" });
      break;

    case "xai":
      requireApiKey("xAI", apiKey);
      result = XAI.toLLMProvider({ apiKey, model: resolvedModel, allowLocalExemption: provenance === "user" });
      break;

    case "openrouter":
      requireApiKey("OpenRouter", apiKey);
      result = OpenRouter.toLLMProvider({
        apiKey,
        model: resolvedModel,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        allowLocalExemption: provenance === "user",
      });
      break;

    case "azure":
      requireApiKey("Azure OpenAI", apiKey);
      result = Azure.toLLMProvider({
        apiKey,
        model: resolvedModel,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(resourceName ? { resourceName } : {}),
        allowLocalExemption: provenance === "user",
      });
      break;

    case "google": {
 // Google Vertex AI is reached through its OpenAI-compatible endpoint
 // (https://ai.googleapis.com/v1beta1/projects/{project}/locations/{loc}/...).
 // The project/location are specific to the user's GCP setup, so there is
 // no single static default URL — the user must supply `baseUrl` in
 // Options. Route through the OpenAICompatible facade once a baseUrl is
 // present.
      requireApiKey("Google (Vertex AI)", apiKey);
      // Vertex AI has no static default (the user must supply `baseUrl`); this
      // is intentional — `google` is deliberately absent from `DEFAULT_BASE_URLS`.
      if (!baseUrl) {
        throw new Error(
          "Google (Vertex AI) requires a baseUrl. Enter your Vertex OpenAI-compatible endpoint in Options (e.g. https://ai.googleapis.com/v1beta1/projects/…/locations/…/endpoints/openai)."
        );
      }
      result = OpenAICompatible.toLLMProvider({
        provider: "google",
        apiKey,
        model: resolvedModel,
        baseURL: baseUrl,
        allowLocalExemption: provenance === "user",
      });
      break;
    }

    default: {
 // Generic OpenAI-compatible fallback (resolution step 2): ANY catalog
 // provider that exposes an `api` base URL gets a runtime facade built via
 // `makeOpenAIChatFacade` — this is what makes ALL dataset providers work
 // without a hard-coded case. `fetchCatalog` is memoized/cached, so this is a
 // single short-circuited lookup after the first call. The user-supplied
 // `baseUrl` (if any) has already been vetted by the SSRF guard + canonical
 // host confinement above, exactly as for every other branch.
      const catalog = await fetchCatalog();
      const catEntry = catalog[provider];
      if (catEntry?.api) {
        // A keyed catalog provider must still reject a missing key. The SSRF
        // guard + canonical-host confinement above don't substitute for
        // authentication, and silently building an unauthenticated facade for a
        // remote keyed endpoint would let a keyless request reach an unintended
        // host. This mirrors the dedicated-provider cases and the profile
        // fallback below (which also throw "requires an API key").
        const isLocal = provider === "ollama" || provider === "litellm" ||
          !!catEntry.api?.match(/localhost|127\.0\.0\.1|\[::1\]/);
        const needsKey = !isLocal && (catEntry.env == null || catEntry.env.length > 0);
        if (needsKey) requireApiKey(provider, apiKey);
        const facade = makeOpenAIChatFacade({
          id: provider,
          displayName: catEntry.name,
          envKey: catEntry.env?.[0] ?? "API_KEY",
          routeId: "openai-compatible-chat",
          protocol: OpenAICompatibleChat.protocol,
          path: OpenAICompatibleChat.PATH,
          defaultBaseURL: catEntry.api,
        });
        result = facade.toLLMProvider({
          apiKey,
          model: resolvedModel,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          allowLocalExemption: provenance === "user",
        });
        break;
      }

 // Step 3: recognized openai-compatible profile (groq, together, cerebras,
 // deepseek, mistral, qwen, baseten, fireworks, deepinfra, …). Step 4: a
 // provider that isn't in `KNOWN_PROVIDERS` AND isn't a catalog/`api` provider
 // is genuinely unknown — report that precisely instead of masking it behind
 // the API-key check (which would otherwise throw "${provider} requires an
 // API key" for an unrecognized id, hiding the real problem — ).
      if (!KNOWN_PROVIDERS.has(provider)) {
        throw new Error(
          `Unknown provider "${provider}". Pick one of: ${[...KNOWN_PROVIDERS].join(", ")}.`
        );
      }
      const needsKey = provider !== "ollama";
      if (needsKey) requireApiKey(provider, apiKey);
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
        allowLocalExemption: provenance === "user",
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
  try {
    const visionCapable = await modelSupportsVision(resolvedModel, catalogProviderId);
    if (visionCapable !== result.supportsVision) {
      result = {
        ...result,
        supportsVision: visionCapable,
      };
    }
  } catch {
 // FAIL-SAFE (SAFE): on catalog lookup failure, fall back to the pure,
 // network-free name heuristic (`resolveVisionSupport(resolvedModel, [])`) —
 // `[]` means no catalog models, so only the `VISION_PATTERNS` heuristic runs.
 // An offline catalog error should NOT silently disable vision for well-known
 // vision-capable models (e.g. gpt-4o): the heuristic restores vision for those
 // while still returning `false` for models it doesn't recognise.
    result = { ...result, supportsVision: resolveVisionSupport(resolvedModel, []) };
  }

 // Patch supportsReasoning based on per-MODEL detection. Reasoning models
 // (OpenAI o1/o3/o4, xAI grok-4-reasoning) reject or ignore `temperature`
 // and expect `max_completion_tokens`; sending temperature can yield HTTP 400
 // or waste the parameter. The flag is computed from the catalog's per-model
 // `reasoning` field with a name-pattern fallback. On catalog failure, do NOT
 // assume reasoning (leave undefined) so callers default to sending temperature
 // — the conservative choice for non-reasoning models.
  try {
    const reasoning = await modelSupportsReasoning(resolvedModel, catalogProviderId);
    if (reasoning !== result.supportsReasoning) {
      result = { ...result, supportsReasoning: reasoning };
    }
  } catch {
    /* catalog/lookup failure — leave supportsReasoning unset (non-reasoning default) */
  }

  // forceReasoning user override ("on" | "off" | "auto"): "on" forces
  // reasoning-parameter emission even for models the catalog doesn't flag
  // (e.g. an OpenAI-compatible reasoning model unknown to the catalog);
  // "off" is handled downstream (callers send `reasoning.enabled: false` so
  // protocols suppress reasoning params); "auto"/unset keep the
  // catalog-derived flag. Read fail-safe — a missing or corrupt storage
  // layer must never crash provider construction.
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const { forceReasoning } = await chrome.storage.local.get("forceReasoning");
      if (forceReasoning === "on" && result.supportsReasoning !== true) {
        result = { ...result, supportsReasoning: true };
      }
    }
  } catch {
    /* fail-safe: keep the catalog-derived flag */
  }

  return result;
}

/**
 * Read the user's API key. The key lives in `chrome.storage.session`
 * (in-memory storage cleared when the browser restarts) — see
 * `api-key-storage.ts`. The Options page write side (`settings-sync.ts`
 * `saveSettings`) stores the key in session storage and only mirrors it to
 * disk when the user opts in via the "remember on this device" checkbox;
 * `ensureApiKeyInSession` re-hydrates the session from that mirror after a
 * restart — and NEVER trusts a plaintext-disk key without the consent flag.
 * Never console.log the value.
 */
async function readStoredApiKey(): Promise<string> {
  return ensureApiKeyInSession();
}

/**
 * Read the provider config from `chrome.storage.local`. Returns null if the
 * provider hasn't been configured yet.
 *
 * Provider-scoped config record (O8): `chrome.storage.local["providerConfigs"]`
 * is keyed by provider id and holds per-provider model/baseUrl/resourceName. A
 * nested entry for the RESOLVED provider wins over the flat top-level keys,
 * which stay as the active back-compat mirror (so older tooling that only
 * writes the top-level keys keeps working, and the UI keeps a single mirror to
 * write). The nested record's provenance follows the same fail-safe as the
 * top-level: only an explicit `"user"` stamp is trusted, anything else —
 * absent or malformed — is `"injected"` (no SSRF loopback exemption).
 */
export async function readProviderConfig(): Promise<ProviderConfig | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  const res = await chrome.storage.local.get([
    "provider",
    "model",
    "baseUrl",
    "resourceName",
    "provenance",
    "providerConfigs",
  ]);
  const provider = normalizeString(res.provider);
  if (!provider) return null; // no provider set → unconfigured user
 // Defense-in-depth: a corrupted / injected `chrome.storage.local` payload
 // could carry an arbitrary provider id. Fall back to the default. The
 // fallback deliberately CLEARS the stored API key (below) to prevent
 // cross-provider exfiltration, so the agent IS locked out until the user
 // re-enters the key — that is the intent. Write a one-time flag so the
 // Options UI can surface a warning.
  let resolvedProvider = provider;
  if (!KNOWN_PROVIDERS.has(provider)) {
    console.warn(
      `[provider-config] Unknown provider "${provider}" read from storage; falling back to default.`
    );
    resolvedProvider = "openai";
    try {
      await chrome.storage.local.set({ provider_reset_warning: true });
    } catch { /* non-fatal */ }
  }
 // The API key is NOT per-provider — it is a single session-storage key (see
 // `readStoredApiKey`), so it is read once after provider resolution. When the
 // provider was UNKNOWN and we fell back to the default, the stored key belongs
 // to a different provider: forwarding it to the default host would exfiltrate
 // it (e.g. an Anthropic key sent to api.openai.com). Clear it so the user must
 // re-enter the key for the reset provider.
  const apiKey = resolvedProvider === provider ? await readStoredApiKey() : "";
  const model = normalizeString(res.model);
  const baseUrl = normalizeString(res.baseUrl);
  const resourceName = normalizeString(res.resourceName);
 // Provenance: fail-safe toward the stricter `"injected"` state. A stored
 // `"user"` value is trusted (the Options save path stamps it); anything else
 // — absent, malformed, or an attacker-injected write — is treated as
 // `"injected"` so it is NOT exempted from the SSRF loopback guard.
  const provenance: ProviderConfig["provenance"] =
    res.provenance === "user" ? "user" : "injected";
  return {
    provider: resolvedProvider,
    apiKey,
    model,
    baseUrl: baseUrl || undefined,
    resourceName: resourceName || undefined,
    provenance,
    ...applyNestedProviderConfig(resolvedProvider, res.providerConfigs),
  };
}

/**
 * Merge the provider-scoped nested record over the flat top-level values.
 * Only the per-provider scope-guarded fields (model/baseUrl/resourceName/
 * provenance) are read — no headers/options passthrough bags. The nested
 * provenance uses the same fail-safe as the top-level (`"user"` only).
 */
function applyNestedProviderConfig(
  resolvedProvider: string,
  raw: unknown,
): Partial<ProviderConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entry = (raw as Record<string, unknown>)[resolvedProvider];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const rec = entry as Record<string, unknown>;
  const out: Partial<ProviderConfig> = {};
  const nestedModel = normalizeString(rec.model);
  const nestedBaseUrl = normalizeString(rec.baseUrl);
  const nestedResourceName = normalizeString(rec.resourceName);
  if (nestedModel) out.model = nestedModel;
  if (nestedBaseUrl) out.baseUrl = nestedBaseUrl;
  if (nestedResourceName) out.resourceName = nestedResourceName;
  // Only an explicit "user" stamp is trusted; absent or malformed → "injected"
  // (no SSRF loopback exemption for the nested baseUrl).
  out.provenance = rec.provenance === "user" ? "user" : "injected";
  return out;
}

/**
 * Coerce a stored value to a string. `chrome.storage` access returns `unknown`,
 * and a corrupted / coerced payload (e.g. a number or boolean from a buggy
 * synced-settings write) would otherwise flow through `as string` unchanged and
 * reach the provider constructors as the wrong type. Reject non-string values
 * explicitly (returning "") so downstream code always sees a real string.
 */
export function normalizeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
