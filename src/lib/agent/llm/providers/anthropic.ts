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
import { assertSafeUserBaseURL } from "./openai-compatible-profile";

export const id = "anthropic";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("ANTHROPIC_API_KEY"))
    .pipe(Auth.header("x-api-key"));
};

export function configure(input: Config = {}) {
 // (SSRF guard): validate any user-supplied baseURL override before
 // building the route/endpoint. The trusted default is exempt.
  assertSafeUserBaseURL(input.baseURL, id);
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

/**
 * Synchronous, coarse vision-capability gate for Anthropic model ids.
 *
 * The authoritative per-model check lives in the catalog
 * (`modelSupportsVision`) and is applied at the provider-config layer
 * (`buildProvider` patches `supportsVision` after default resolution). This
 * gate only corrects the obvious legacy cases so the facade default is not
 * blindly `true` for *every* model id — e.g. `claude-2` / `claude-instant`
 * cannot accept image inputs and would otherwise be misreported as
 * vision-capable, risking image blocks the model rejects.
 *
 * All current Claude 3+ families support vision; legacy `claude-1`,
 * `claude-2`, and `claude-instant` do not.
 */
function anthropicModelSupportsVision(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return !(
    id.startsWith("claude-1") ||
    id.startsWith("claude-2") ||
    id.includes("claude-instant")
  );
}

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
    supportsVision: anthropicModelSupportsVision(config.model),
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
