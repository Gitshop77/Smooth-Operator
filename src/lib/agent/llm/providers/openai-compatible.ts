/**
 * Generic OpenAI-compatible provider facade — works with ANY provider that
 * speaks the OpenAI Chat Completions protocol at a different base URL.
 *
 * Generic factory + profile table:
 *   - `configure(profile, input)` builds a Route for a specific profile.
 *   - `toLLMProvider(config)` bridges to the agent's `LLMProvider` interface,
 *     looking up the profile by `config.provider` (falls back to `config.baseURL`).
 *
 * The `frequency_penalty = 0.3` is added by the openai-compatible-chat
 * protocol to prevent infinite generation.
 *
 * Auth chain: explicit `apiKey` (no env-var fallback — the env-var name is
 * provider-specific, so callers like the extension supply the key explicitly).
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat";
import { PATH } from "../protocols/openai-compatible-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import {
  byProvider,
  type OpenAICompatibleProfile,
  assertSafeUserBaseURL,
} from "./openai-compatible-profile";

export const id = "openai-compatible";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  const apiKey = "apiKey" in options ? options.apiKey : undefined;
  // Keyless providers (Ollama, LiteLLM without auth) — use Auth.none instead
  // of Auth.optional().bearer() which throws MissingCredentialError when no
  // key is provided. Auth.optional throws on undefined; Auth.none is a no-op
  // that passes headers through unchanged.
  if (!apiKey) return Auth.none;
  return Auth.optional(apiKey, "apiKey").pipe(Auth.bearer);
};

/**
 * Build a Route for a specific OpenAI-compatible profile.
 *
 * @param profile - The provider profile (provider id + baseURL).
 * @param input   - Optional config overrides (baseURL, apiKey/auth).
 */
export function configure(profile: OpenAICompatibleProfile, input: Config = {}) {
  // (SSRF guard): validate any user-supplied baseURL override before
  // building the route/endpoint.
  assertSafeUserBaseURL(input.baseURL);
  const baseURL = input.baseURL ?? profile.baseURL;
  const route = make({
    id: `openai-compatible:${profile.provider}`,
    provider: profile.provider,
    protocol: OpenAICompatibleChat.protocol,
    endpoint: Endpoint.path(PATH, { baseURL }),
    auth: auth(input),
    framing: Framing.sse,
  });
  return {
    id: profile.provider,
    model: (modelID: string) => route.model({ id: modelID }),
    configure: (next: Config = {}) => configure(profile, { ...input, ...next } as Config),
  };
}

/**
 * Resolve a profile by provider id. Falls back to a synthesized profile when
 * the provider isn't in the table (caller must supply baseURL).
 */
export function resolveProfile(provider: string, baseURL?: string): OpenAICompatibleProfile {
  // (SSRF guard): validate ANY caller-supplied baseURL here — for a known
  // provider the baseURL override (if any) is still honored by `configure`, so
  // it must be checked at resolution time too, not only for unknown providers.
  // `configure` re-validates as the single source of truth before building a
  // route, so the guard can never be silently dropped by a future refactor.
  assertSafeUserBaseURL(baseURL);
  const direct = byProvider[provider];
  if (direct) return direct;
  // Unknown provider — synthesize from the caller-supplied baseURL.
  if (!baseURL) {
    throw new Error(
      `Unknown OpenAI-compatible provider "${provider}". Supply a baseURL via config.`
    );
  }
  // Unknown provider — default supportsStructuredOutput to false so the
  // in-prompt schema fallback fires (safer assumption for unknown endpoints).
  return { provider, baseURL, supportsStructuredOutput: false };
}

/**
 * Bridge to the agent's `LLMProvider` interface.
 *
 * Required config fields:
 *   - `provider` — provider id (e.g. "deepseek", "groq", "together", or any
 *                  custom id; unknown ids require `baseURL`).
 *   - `model`    — model name to send in the request body.
 * Optional:
 *   - `baseURL`  — override the profile's default baseURL.
 *   - `apiKey`/`auth` — credentials (local providers like Ollama don't need one).
 */
export function toLLMProvider(
  config: Config & { model: string; provider: string }
): LLMProvider {
  const profile = resolveProfile(config.provider, config.baseURL);
  return toLLMProviderBridge({
    providerId: config.provider,
    providerDisplayName: config.provider,
    model: config.model,
    supportsVision: false,
    supportsStructuredOutput: profile.supportsStructuredOutput,
    configureResult: configure(profile, config),
  });
}

// ─── Pre-configured profiles ─────────────────────────────────────────────────
// The curated profile table lives in `openai-compatible-profile.ts` and is
// consumed via `toLLMProvider({ provider, model, apiKey? })` (see
// `provider-config.ts`). No per-profile named exports are provided here: they
// were dead API surface that also resolved to `Auth.none` (no way to inject a
// key), and the `openrouter` export collided with the standalone `openrouter.ts`
// module. Callers that need a specific provider go through `toLLMProvider`.
