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

import { apiKeyAuth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as AnthropicMessages from "../protocols/anthropic-messages";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { assertSafeUserBaseURL } from "./openai-compatible-profile";
import type { SsrfProvenance } from "../route/ssrf";

export const id = "anthropic";

export type Config = {
  baseURL?: string;
  // When true (user-configured provenance) the curated-local-provider loopback
  // exemption is honored; otherwise loopback / RFC1918 / ULA are rejected.
  allowLocalExemption?: boolean;
} & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) =>
  apiKeyAuth(options, "ANTHROPIC_API_KEY", "x-api-key");

export function configure(input: Config = {}) {
 // (SSRF guard): validate any user-supplied baseURL override before
 // building the route/endpoint. The trusted default is exempt. Forward the
 // user-provenance exemption flag so the curated-local-origin exemption applies
 // only for a user-configured baseURL.
  assertSafeUserBaseURL(input.baseURL, id, input.allowLocalExemption);
  // Derive SSRF provenance from allowLocalExemption: when the user explicitly
  // configured this provider (allowLocalExemption=true), provenance is
  // "user-configured"; otherwise "untrusted". This ensures the async DNS
  // validation in transport-http.ts uses the correct trust level.
  const provenance: SsrfProvenance = input.allowLocalExemption ? "user-configured" : "untrusted";
  const route = make({
    id: "anthropic-messages",
    provider: id,
    protocol: AnthropicMessages.protocol,
    endpoint: Endpoint.path(AnthropicMessages.PATH, {
      baseURL: input.baseURL ?? AnthropicMessages.DEFAULT_BASE_URL,
    }),
    auth: auth(input),
    framing: Framing.sse,
    provenance,
    headers: {
      "anthropic-version": AnthropicMessages.API_VERSION,
 // Lets browser contexts (extension service worker) call the API directly.
      "anthropic-dangerous-direct-browser-access": "true",
 // Enables the 1-hour prompt-cache `ttl` emitted on system blocks by the
 // anthropic-messages protocol; without this beta the API rejects the
 // `ttl` field with a 400 invalid_request_error.
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
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
  const lowerId = modelId.toLowerCase();
  return !(
    lowerId.startsWith("claude-1") ||
    lowerId.startsWith("claude-2") ||
    lowerId.includes("claude-instant")
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
