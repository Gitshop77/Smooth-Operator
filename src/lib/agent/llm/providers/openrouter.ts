/**
 * OpenRouter provider facade — uses the openai-compatible-chat protocol
 * against `https://openrouter.ai/api/v1/chat/completions` with bearer auth.
 *
 * Auth chain: explicit `apiKey` → `OPENROUTER_API_KEY` env var → throw.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat";
import { PATH } from "../protocols/openai-compatible-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { profiles } from "./openai-compatible-profile";

export const id = "openrouter";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("OPENROUTER_API_KEY"))
    .pipe(Auth.bearer);
};

export function configure(input: Config = {}) {
  const route = make({
    id: "openai-compatible-chat",
    provider: id,
    protocol: OpenAICompatibleChat.protocol,
    endpoint: Endpoint.path(PATH, {
      baseURL: input.baseURL ?? profiles.openrouter.baseURL,
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

export const provider = configure();

/**
 * Bridge to the agent's `LLMProvider` interface.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  return toLLMProviderBridge({
    providerId: "openrouter",
    providerDisplayName: "OpenRouter",
    model: config.model,
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
