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
  deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1", supportsStructuredOutput: true },
  fireworks: { provider: "fireworks", baseURL: "https://api.fireworks.ai/inference/v1", supportsStructuredOutput: true },
  groq: { provider: "groq", baseURL: "https://api.groq.com/openai/v1", supportsStructuredOutput: true },
  qwen: { provider: "qwen", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", supportsStructuredOutput: true },
  mistral: { provider: "mistral", baseURL: "https://api.mistral.ai/v1", supportsStructuredOutput: true },
  openrouter: { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1", supportsStructuredOutput: true },
  together: { provider: "together", baseURL: "https://api.together.xyz/v1", supportsStructuredOutput: true },
  xai: { provider: "xai", baseURL: "https://api.x.ai/v1", supportsStructuredOutput: true },
  // Ollama's OpenAI-compatible shim accepts `response_format: { type: "json_object" }`
  // but does NOT honor the full `json_schema` variant reliably across model
  // families. Default false so the in-prompt schema fallback fires.
  ollama: { provider: "ollama", baseURL: "http://localhost:11434/v1", supportsStructuredOutput: false },
  opencode: { provider: "opencode", baseURL: "https://opencode.ai/api/v1", supportsStructuredOutput: true },
  // LiteLLM is a proxy — structured-output support depends on the upstream
  // model it routes to, which we can't know at config time. Default false so
  // the fallback fires; users whose upstream supports it can override.
  litellm: { provider: "litellm", baseURL: "http://localhost:4000/v1", supportsStructuredOutput: false },
} as const satisfies Record<string, OpenAICompatibleProfile>;

export const byProvider: Record<string, OpenAICompatibleProfile> = Object.fromEntries(
  Object.values(profiles).map((p) => [p.provider, p]),
);

// (SSRF guard): a user-supplied `baseURL` is untrusted input. Validate it
// before it is used to build a provider profile / endpoint, so the service
// worker cannot be steered at a loopback, RFC1918, or cloud-metadata address.
//
// The curated `profiles` table (Ollama/LiteLLM loopback defaults) is built
// directly from `profiles` and never passes through this check. The localhost
// exemption below is therefore scoped to those two local providers only — any
// other provider id (or an unknown provenance) is held to the strict
// `validateLlmBaseUrl` policy that rejects loopback/RFC1918/metadata URLs.
const LOCAL_PROVIDER_IDS = new Set(["ollama", "litellm"]);

/** True iff `url`'s origin exactly matches a curated local-provider endpoint. */
function isCuratedLocalOrigin(url: string): boolean {
  try {
    const origin = new URL(url).origin;
    return LOCAL_PROVIDER_BASE_URLS.some((curated) => new URL(curated).origin === origin);
  } catch {
    return false;
  }
}

/**
 * Validate a USER-SUPPLIED `baseURL` override before it is used to build a
 * provider profile / endpoint.
 *
 * The localhost exemption (Ollama `http://localhost:11434`, LiteLLM
 * `http://localhost:4000`) is ONLY granted when `provider` is explicitly one
 * of those local providers AND the URL matches their exact curated origin. For
 * every other provider — or when provenance is unknown (`provider` omitted) —
 * the strict {@link validateLlmBaseUrl} policy is applied, which rejects
 * loopback / RFC1918 / cloud-metadata URLs. This closes the hole where an
 * injected `http://localhost:11434` could pass the guard when routed through an
 * arbitrary provider id (e.g. `deepseek`).
 *
 * Note: the final fetch URL is also re-checked at the transport layer
 * (`transport-http.ts`); that enforcement point is the authoritative
 * defense-in-depth check and is tracked separately.
 */
export const assertSafeUserBaseURL = (
  baseURL: string | undefined,
  provider?: string,
): void => {
  if (!baseURL) return; // no user-supplied override → use the curated profile
  if (provider && LOCAL_PROVIDER_IDS.has(provider) && isCuratedLocalOrigin(baseURL)) {
    if (!isAllowedLlmBaseUrl(baseURL)) {
      throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${baseURL}`);
    }
    return;
  }
  const res = validateLlmBaseUrl(baseURL);
  if (!res.ok) {
    throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${baseURL} (${res.reason})`);
  }
};
