/**
 * xAI (Grok) provider facade — uses the openai-compatible-chat protocol
 * against `https://api.x.ai/v1/chat/completions` with bearer auth.
 *
 * Auth chain: explicit `apiKey` → `XAI_API_KEY` env var → throw.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat";
import { PATH } from "../protocols/openai-compatible-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { profiles, assertSafeUserBaseURL } from "./openai-compatible-profile";

export const id = "xai";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("XAI_API_KEY"))
    .pipe(Auth.bearer);
};

export function configure(input: Config = {}) {
  // (SSRF guard): validate any user-supplied baseURL override before
  // building the route/endpoint. The trusted default is exempt.
  assertSafeUserBaseURL(input.baseURL);
  const route = make({
    id: "openai-compatible-chat",
    provider: id,
    protocol: OpenAICompatibleChat.protocol,
    endpoint: Endpoint.path(PATH, {
      baseURL: input.baseURL ?? profiles.xai.baseURL,
    }),
    auth: auth(input),
    framing: Framing.sse,
  });
  return {
    id,
    model: (modelID: string) => route.model({ id: modelID }),
    configure,
  };
}

/**
 * Bridge to the agent's `LLMProvider` interface.
 *
 * `supportsVision: true` — xAI Grok-2 Vision accepts image inputs (see
 * `pricing.ts`'s `grok-2-vision` entry). The per-model catalog lookup in
 * `buildProvider` (provider-config.ts) overrides this for non-vision Grok
 * models (e.g. plain `grok-2`), so setting `true` here is the safe default:
 * vision-capable models are correctly detected, and non-vision models get
 * downgraded by the catalog lookup.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  return toLLMProviderBridge({
    providerId: "xai",
    providerDisplayName: "xAI",
    model: config.model,
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
