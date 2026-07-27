/**
 * OpenAI-compatible provider profiles — base URLs for known providers.
 *
 * A profile is just a `{ provider, baseURL, supportsStructuredOutput }` triple:
 * enough to identify which OpenAI-compatible endpoint to hit AND whether it
 * honors the OpenAI `response_format: { type: "json_schema", … }` parameter.
 * The `profiles` table lists every provider we know how to talk to, and
 * `byProvider` lets callers look one up by id (e.g. `byProvider.groq` →
 * `{ provider: "groq", baseURL: "https://api.groq.com/openai/v1", supportsStructuredOutput: true }`).
 *
 * `supportsStructuredOutput` is per-profile, not hardcoded `true` for every
 * OpenAI-compatible profile. Local proxies (Ollama, LiteLLM) don't reliably
 * honor `response_format` — for those, the extension's `llm-direct.ts` falls
 * back to inlining the JSON schema into the system prompt so the model still
 * gets a concrete contract. Cloud providers that implement the OpenAI
 * structured-output spec set this `true`.
 */

import {
  isAllowedLlmBaseUrl,
  validateLlmBaseUrl,
  LOCAL_PROVIDER_BASE_URLS,
} from "../route/ssrf";

export interface OpenAICompatibleProfile {
  readonly provider: string;
  readonly baseURL: string;
  /** Whether this endpoint honors `response_format: { type: "json_schema" }`. */
  readonly supportsStructuredOutput: boolean;
}

export const profiles = {
  baseten: { provider: "baseten", baseURL: "https://inference.baseten.co/v1", supportsStructuredOutput: true },
  cerebras: { provider: "cerebras", baseURL: "https://api.cerebras.ai/v1", supportsStructuredOutput: true },
  deepinfra: { provider: "deepinfra", baseURL: "https://api.deepinfra.com/v1/openai", supportsStructuredOutput: true },
  deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com", supportsStructuredOutput: true },
  fireworks: { provider: "fireworks", baseURL: "https://api.fireworks.ai/inference/v1", supportsStructuredOutput: true },
  groq: { provider: "groq", baseURL: "https://api.groq.com/openai/v1", supportsStructuredOutput: true },
  qwen: { provider: "qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", supportsStructuredOutput: true },
  mistral: { provider: "mistral", baseURL: "https://api.mistral.ai/v1", supportsStructuredOutput: true },
  openrouter: { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1", supportsStructuredOutput: true },
  together: { provider: "together", baseURL: "https://api.together.ai/v1", supportsStructuredOutput: true },
  xai: { provider: "xai", baseURL: "https://api.x.ai/v1", supportsStructuredOutput: true },
 // Ollama's OpenAI-compatible shim accepts `response_format: { type: "json_object" }`
 // but does NOT honor the full `json_schema` variant reliably across model
 // families. Default false so the in-prompt schema fallback fires.
  ollama: { provider: "ollama", baseURL: "http://localhost:11434/v1", supportsStructuredOutput: false },
  opencode: { provider: "opencode", baseURL: "https://opencode.ai/zen/v1", supportsStructuredOutput: true },
  "opencode-go": { provider: "opencode-go", baseURL: "https://opencode.ai/zen/go/v1", supportsStructuredOutput: true },
 // LiteLLM is a proxy — structured-output support depends on the upstream
 // model it routes to, which we can't know at config time. Default false so
 // the fallback fires; users whose upstream supports it can override.
  litellm: { provider: "litellm", baseURL: "http://localhost:4000/v1", supportsStructuredOutput: false },
} as const satisfies Record<string, OpenAICompatibleProfile>;

export const byProvider: Record<string, OpenAICompatibleProfile> = Object.fromEntries(
  Object.values(profiles).map((p) => [p.provider, p]),
);

/**
 * Thrown when a user-supplied LLM `baseURL` fails the SSRF guard. Callers can
 * branch on `instanceof UnsafeBaseUrlError` to surface a specific "invalid /
 * unsafe endpoint" message rather than string-matching a generic `Error`.
 */
export class UnsafeBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBaseUrlError";
  }
}

// (SSRF guard): a user-supplied `baseURL` is untrusted input. Validate it
// before it is used to build a provider profile / endpoint, so the service
// worker cannot be steered at a loopback, RFC1918, or cloud-metadata address.
//
// The curated `profiles` table (Ollama/LiteLLM loopback defaults) is built
// directly from `profiles` and never passes through this check. The narrow
// localhost exemption below is scoped to those two local providers ONLY — when
// `provider` is explicitly `ollama`/`litellm` AND the URL matches the exact
// curated origin, the stricter `isAllowedLlmBaseUrl` (which still rejects
// private/metadata addresses) is applied. For every other provider — or when
// provenance is unknown — the strict `validateLlmBaseUrl` policy is applied,
// which rejects loopback / RFC1918 / cloud-metadata URLs. This closes the hole
// where an injected `http://localhost:11434` could pass the guard when routed
// through an arbitrary provider id (e.g. `deepseek`). `openai-compatible.ts`
// actually passes `profile.provider`, so the exemption is applied per-provider
// rather than universally.
//
// Failures throw {@link UnsafeBaseUrlError} so callers can branch on the type
// rather than string-matching the message.
const LOCAL_PROVIDER_IDS = new Set(["ollama", "litellm"]);

/** Pre-computed set of curated local-provider origins (parsed once). */
const CURATED_LOCAL_ORIGINS = new Set(
  LOCAL_PROVIDER_BASE_URLS.map((u) => new URL(u).origin),
);

/** True iff `url`'s origin exactly matches a curated local-provider endpoint. */
function isCuratedLocalOrigin(url: string): boolean {
  try {
    return CURATED_LOCAL_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** Strip embedded `user:pass@` credentials AND any query/fragment from a URL
 * before it reaches logs/UI, so secrets passed as query params are not leaked
 * in SSRF error messages. Mirrors the sibling redactor in `ssrf.ts`. */
function redactUrl(u: string): string {
  return u.replace(/\/\/[^@/]*@/, "//").replace(/[?#].*$/, "");
}

export const assertSafeUserBaseURL = (
  baseURL: string | undefined,
  provider?: string,
  // `allowLocalExemption` is true only for a USER-configured `baseURL`
  // (provenance === "user"). It re-enables the curated-local-provider loopback
  // exemption so a user's own Ollama / LiteLLM keeps working. For any other
  // provenance (injected / unknown) it stays `false`, so a loopback / RFC1918 /
  // ULA `baseURL` smuggled through an arbitrary provider id (e.g. `deepseek`,
  // `groq`) is rejected. Defaults to `false` so a direct call with no provenance
  // is always strict.
  allowLocalExemption: boolean = false,
): void => {
  if (!baseURL) return; // no user-supplied override → use the curated profile
  if (allowLocalExemption && provider && LOCAL_PROVIDER_IDS.has(provider) && isCuratedLocalOrigin(baseURL)) {
    // The curated-local exemption is scoped to the exact ollama/litellm origins
    // and to a USER-configured `baseURL` (provenance === "user", i.e.
    // `allowLocalExemption === true`). An injected / untrusted `baseURL` must
    // NEVER reach this branch — `allowLocalExemption` is false for it, so it
    // falls through to the strict `validateLlmBaseUrl` below and a smuggled
    // loopback / RFC1918 `baseURL` is rejected. Thread `allowLocalExemption`
    // through so `isAllowedLlmBaseUrl` cannot re-grant the exemption for an
    // untrusted origin.
    if (!isAllowedLlmBaseUrl(baseURL, allowLocalExemption)) {
      throw new UnsafeBaseUrlError(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrl(baseURL)}`);
    }
    return;
  }
 // For every non-curated-local provider (or an unknown provenance) apply the
 // policy selected by `allowLocalExemption`: when `false` (the default,
 // including any injected / untrusted `baseURL`) a loopback / RFC1918 / ULA
 // `baseURL` smuggled through an arbitrary provider id (e.g. `deepseek`,
 // `groq`) is rejected; when `true` (user-configured) the curated-local
 // exemption above is the only path that re-allows loopback, and only for the
 // exact ollama/litellm origins.
  const res = validateLlmBaseUrl(baseURL, allowLocalExemption);
  if (!res.ok) {
    throw new UnsafeBaseUrlError(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrl(baseURL)} (${res.reason})`);
  }
};
