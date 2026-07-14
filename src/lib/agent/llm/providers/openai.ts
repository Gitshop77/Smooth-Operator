/**
 * OpenAI provider facade — uses the openai-chat protocol against
 * `https://api.openai.com/v1/chat/completions` with bearer auth.
 *
 * Auth chain: explicit `apiKey` → `OPENAI_API_KEY` env var → throw.
 *
 * OpenAI, OpenRouter and xAI are near-verbatim OpenAI-compatible facades: only
 * `id`, display name, env var and default base URL differ. The shared boilerplate
 * lives in `makeOpenAIChatFacade` below, so a single change (e.g. an SSRF guard
 * or a new capability flag) propagates to every compatible provider at once.
 * xAI keeps its own file for clearer module ownership but already uses this
 * same factory via makeOpenAIChatFacade, so SSRF/auth/framing boilerplate
 * cannot diverge.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAIChat from "../protocols/openai-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { assertSafeUserBaseURL } from "./openai-compatible-profile";
import type { Protocol } from "../route/client";

export type Config = { baseURL?: string } & ProviderAuthOption<"optional">;

/** Definition for one OpenAI-compatible provider facade. */
export interface OpenAIChatFacadeDef<P extends Protocol<any, any, any, any> = Protocol> {
  id: string;
  displayName: string;
  envKey: string;
  routeId: string;
  protocol: P;
  path: string;
  defaultBaseURL: string;
}

export interface OpenAIChatFacadeConfigure {
  id: string;
  model: (modelID: string) => unknown;
  configure: (input?: Config) => OpenAIChatFacadeConfigure;
}

/**
 * Build an OpenAI-compatible provider facade (OpenAI, OpenRouter, …). The
 * returned `{ id, configure, toLLMProvider }` preserves the exact public surface
 * of the old hand-written facades.
 */
export function makeOpenAIChatFacade<P extends Protocol<any, any, any, any> = Protocol>(
  def: OpenAIChatFacadeDef<P>,
) {
  const auth = (options: ProviderAuthOption<"optional">) => {
    if ("auth" in options && options.auth) return options.auth;
    return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
      .orElse(Auth.config(def.envKey))
      .pipe(Auth.bearer);
  };

  function configure(input: Config = {}): OpenAIChatFacadeConfigure {
 // (SSRF guard): validate any user-supplied baseURL override before
 // building the route/endpoint. The trusted default is exempt.
    assertSafeUserBaseURL(input.baseURL, def.id);
    // Split the (possibly path-prefixed) base URL into origin + path-prefix and
    // re-attach the prefix to `def.path` so `buildURL`'s `new URL(path, base)`
    // (which replaces the base path for a leading-slash path) doesn't drop a
    // required segment like `/v1` (would yield a 404/401).
    const url = new URL(input.baseURL ?? def.defaultBaseURL);
    const prefix = url.pathname.replace(/\/+$/, "");
    const route = make({
      id: def.routeId,
      provider: def.id,
      protocol: def.protocol,
      endpoint: Endpoint.path(`${prefix}${def.path}`, { baseURL: url.origin }),
      auth: auth(input),
      framing: Framing.sse,
    });
    return {
      id: def.id,
      model: (modelID: string) => route.model({ id: modelID }),
      configure,
    };
  }

  function toLLMProvider(config: Config & { model: string }): LLMProvider {
    return toLLMProviderBridge({
      providerId: def.id,
      providerDisplayName: def.displayName,
      model: config.model,
 // `supportsVision` defaults to `true`; the authoritative per-model value is
 // patched by the catalog layer (`buildProvider`) after default resolution, so
 // a model id absent from the catalog is reported as vision-capable. This matches
 // Anthropic's facade pattern (which gates legacy models) — the catalog is the
 // single source of truth and must cover every model these facades can serve.
      supportsVision: true,
      supportsStructuredOutput: true,
      configureResult: configure(config),
    });
  }

  return { id: def.id, configure, toLLMProvider };
}

const facade = makeOpenAIChatFacade({
  id: "openai",
  displayName: "OpenAI",
  envKey: "OPENAI_API_KEY",
  routeId: "openai-chat",
  protocol: OpenAIChat.protocol,
  path: OpenAIChat.PATH,
  defaultBaseURL: OpenAIChat.DEFAULT_BASE_URL,
});

export const id = facade.id;
export const configure = facade.configure;
export const toLLMProvider = facade.toLLMProvider;
