/**
 * Azure OpenAI provider facade — uses the openai-chat protocol against
 * `https://{resource}.openai.azure.com/openai/deployments/{model}/chat/completions?api-version={version}`
 * with `api-key` header auth.
 *
 * Azure's URL embeds the deployment name (the model id) in the path, so
 * `configure().model(id)` builds a fresh Route per model with the
 * deployment-specific path + `api-version` query parameter.
 *
 * Config fields:
 *   - `resourceName` — Azure resource name (becomes `https://{resource}.openai.azure.com`).
 *                     Falls back to `AZURE_OPENAI_RESOURCE_NAME` env var.
 *   - `apiVersion`   — Azure API version (default `2024-10-21`).
 *                     Falls back to `AZURE_OPENAI_API_VERSION` env var.
 *   - `baseURL`      — explicit override (wins over `resourceName`).
 *
 * Auth chain: explicit `apiKey` → `AZURE_OPENAI_API_KEY` env var → throw.
 */

import { Auth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAIChat from "../protocols/openai-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { encodeModelIdForUrl } from "../modelId";

export const id = "azure";

/** Default Azure OpenAI API version (recent stable). */
export const DEFAULT_API_VERSION = "2024-10-21";

export type Config = {
  baseURL?: string;
  resourceName?: string;
  apiVersion?: string;
} & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) => {
  if ("auth" in options && options.auth) return options.auth;
  return Auth.optional("apiKey" in options ? options.apiKey : undefined, "apiKey")
    .orElse(Auth.config("AZURE_OPENAI_API_KEY"))
    .pipe(Auth.header("api-key"));
};

export function configure(input: Config = {}) {
  const resource = input.resourceName ?? (typeof process !== "undefined" ? process.env?.AZURE_OPENAI_RESOURCE_NAME : undefined);
  const apiVersion = input.apiVersion ?? (typeof process !== "undefined" ? process.env?.AZURE_OPENAI_API_VERSION : undefined) ?? DEFAULT_API_VERSION;
  const baseURL = input.baseURL ?? (resource ? `https://${resource}.openai.azure.com` : undefined);

  return {
    id,
    model: (modelID: string) => {
      // Azure URL: /openai/deployments/{deployment}/chat/completions?api-version={version}
      // `encodeModelIdForUrl(modelID)` keeps normal deployment names identical
      // but prevents a malicious/garbage id from injecting path separators into
      // the request URL, and throws on structurally-invalid ids.
      const route = make({
        id: "azure-openai",
        provider: id,
        protocol: OpenAIChat.protocol,
        endpoint: Endpoint.path(`/openai/deployments/${encodeModelIdForUrl(modelID)}/chat/completions`, {
          baseURL,
          query: { "api-version": apiVersion },
        }),
        auth: auth(input),
        framing: Framing.sse,
      });
      return route.model({ id: modelID });
    },
    configure,
  };
}

export const provider = configure();

/**
 * Bridge to the agent's `LLMProvider` interface.
 *
 * Throws a clear error when Azure is selected but not properly configured
 * (neither `resourceName` nor `baseURL` provided, and no
 * `AZURE_OPENAI_RESOURCE_NAME` env var) — instead of silently falling back to
 * OpenAI's public endpoint.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  const envResource = typeof process !== "undefined" ? process.env?.AZURE_OPENAI_RESOURCE_NAME : undefined;
  if (!config.resourceName && !config.baseURL && !envResource) {
    throw new Error(
      "Azure OpenAI is not configured. Set your Azure resource name (resourceName) or a custom baseURL in Options."
    );
  }
  return toLLMProviderBridge({
    providerId: "azure",
    providerDisplayName: "Azure",
    model: config.model,
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
