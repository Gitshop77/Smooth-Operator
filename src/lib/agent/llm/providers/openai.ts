/**
 * OpenAI provider facade — uses the openai-chat protocol against
 * `https://api.openai.com/v1/chat/completions` with bearer auth.
 *
 * OpenAI provider facade:
 *   - `configure(input)` returns `{ id, model(id), configure }`
 *   - `provider` is a pre-configured default instance
 *   - `toLLMProvider(config)` bridges to the agent's `LLMProvider` interface
 *     so the orchestrator can use it without knowing about Routes/Protocols.
 *
 * Auth chain: explicit `apiKey` → `OPENAI_API_KEY` env var → throw.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAIChat from "../protocols/openai-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";

export const id = "openai";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("OPENAI_API_KEY"))
    .pipe(Auth.bearer);
};

export function configure(input: Config = {}) {
  const route = make({
    id: "openai-chat",
    provider: id,
    protocol: OpenAIChat.protocol,
    endpoint: Endpoint.path(OpenAIChat.PATH, { baseURL: input.baseURL ?? OpenAIChat.DEFAULT_BASE_URL }),
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
 * Bridge to the agent's `LLMProvider` interface. Builds a Route via
 * `configure()`, then runs `generate()` per chat call. Usage/cost is
 * re-computed from the live catalog-backed pricing module (the protocol returns
 * `model: ""` + `costUsd: 0`; we override both here).
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  return toLLMProviderBridge({
    providerId: "openai",
    providerDisplayName: "OpenAI",
    model: config.model,
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
