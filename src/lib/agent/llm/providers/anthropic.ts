/**
 * Anthropic provider facade — uses the anthropic-messages protocol against
 * `https://api.anthropic.com/v1/messages` with `x-api-key` header auth.
 *
 * Adds the required `anthropic-version` header (set by the protocol module)
 * and `anthropic-dangerous-direct-browser-access: true` (so browser contexts
 * like the extension service worker can call the API directly).
 *
 * Auth chain: explicit `apiKey` → `ANTHROPIC_API_KEY` env var → throw.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as AnthropicMessages from "../protocols/anthropic-messages";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";

export const id = "anthropic";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("ANTHROPIC_API_KEY"))
    .pipe(Auth.header("x-api-key"));
};

export function configure(input: Config = {}) {
  const route = make({
    id: "anthropic-messages",
    provider: id,
    protocol: AnthropicMessages.protocol,
    endpoint: Endpoint.path(AnthropicMessages.PATH, {
      baseURL: input.baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
    }),
    auth: auth(input),
    framing: Framing.sse,
    headers: {
      "anthropic-version": AnthropicMessages.API_VERSION,
      // Lets browser contexts (extension service worker) call the API directly.
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  return {
    id,
    model: (modelID: string) => route.model({ id: modelID }),
    configure,
  };
}

export const provider = configure();

/**
 * Bridge to the agent's `LLMProvider` interface. The protocol emits usage
 * with `model: ""` + `costUsd: 0`; we fill them in from the canonical
 * pricing module.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  return toLLMProviderBridge({
    providerId: "anthropic",
    providerDisplayName: "Anthropic",
    model: config.model,
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
