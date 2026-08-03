/**
 * Anthropic provider facade — uses the anthropic-messages protocol against
 * `https://api.anthropic.com/v1/messages` with `x-api-key` header auth.
 *
 * Adds the required `anthropic-version` header (sourced from the protocol
 * module's exported `API_VERSION` — the protocol itself does not set headers;
 * the facade attaches it on the route) and
 * `anthropic-dangerous-direct-browser-access: true` (so browser contexts
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
import { isCuratedLocalOrigin, type SsrfProvenance } from "../route/ssrf";

const id = "anthropic";

type Config = {
  baseURL?: string;
  // When true (user-configured provenance) the curated-local-provider loopback
  // exemption MAY be honored — but only for a baseURL that exactly matches a
  // curated local origin (Ollama / LiteLLM). For any other baseURL the SSRF
  // guard stays strict, so this is NOT a blanket toggle that relaxes the guard
  // for every provider.
  allowLocalExemption?: boolean;
} & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) =>
  apiKeyAuth(options, "ANTHROPIC_API_KEY", "x-api-key");

export function configure(input: Config = {}) {
  // (SSRF guard): validate any user-supplied baseURL override before
  // building the route/endpoint. The trusted default is exempt. The curated-
  // local-provider loopback exemption is honored ONLY when the baseURL exactly
  // matches a curated local origin (Ollama / LiteLLM) AND the user opted in; it
  // is NOT a blanket toggle, so an arbitrary (non-curated) loopback / RFC1918
  // baseUrl is always rejected by the guard (mirrors the openai.ts facade).
  const exemption = !!input.allowLocalExemption && !!input.baseURL && isCuratedLocalOrigin(input.baseURL);
  assertSafeUserBaseURL(input.baseURL, id, exemption);
  // Derive SSRF provenance from allowLocalExemption: when the user explicitly
  // configured this provider (allowLocalExemption=true), provenance is
  // "user-configured"; otherwise "untrusted". This ensures the async DNS
  // validation in transport-http.ts uses the correct trust level.
  const provenance: SsrfProvenance = input.allowLocalExemption ? "user-configured" : "untrusted";
  // Split the (possibly path-prefixed) base URL into origin + path-prefix and
  // re-attach the prefix to `PATH` so `buildURL`'s `new URL(path, base)`
  // (which replaces the base path for a leading-slash path) doesn't drop a
  // user-supplied prefix like `/proxy` (mirrors the google.ts facade).
  const parsed = new URL(input.baseURL ?? AnthropicMessages.DEFAULT_BASE_URL);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const route = make({
    id: "anthropic-messages",
    provider: id,
    protocol: AnthropicMessages.protocol,
    endpoint: Endpoint.path(`${basePath}${AnthropicMessages.PATH}`, {
      baseURL: parsed.origin,
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
