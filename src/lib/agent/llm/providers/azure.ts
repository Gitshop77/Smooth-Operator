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
 * - `resourceName` — Azure resource name (becomes `https://{resource}.openai.azure.com`).
 * Falls back to `AZURE_OPENAI_RESOURCE_NAME` env var.
 * - `apiVersion` — Azure API version (default `2024-10-21`).
 * Falls back to `AZURE_OPENAI_API_VERSION` env var.
 * - `baseURL` — explicit override (wins over `resourceName`).
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
import { assertSafeUserBaseURL } from "./openai-compatible-profile";

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

/** Resolve the Azure resource name from config or the environment. */
function resolveEnvResource(): string | undefined {
  return typeof process !== "undefined" ? process.env?.AZURE_OPENAI_RESOURCE_NAME : undefined;
}

/**
 * Throw a clear error when Azure is selected but not properly configured
 * (neither `resourceName` nor `baseURL` provided, and no
 * `AZURE_OPENAI_RESOURCE_NAME` env var). This surfaces the misconfiguration
 * at config time — whether via `configure()` or `toLLMProvider()` — instead
 * of silently producing an empty/relative URL that fails opaquely at request
 * time.
 */
function assertConfigured(input: Config): void {
  if (!input.resourceName && !input.baseURL && !resolveEnvResource()) {
    throw new Error(
      "Azure OpenAI is not configured. Set your Azure resource name (resourceName) or a custom baseURL in Options."
    );
  }
}

/**
 * Azure resource names are DNS labels used to build
 * `https://{resource}.openai.azure.com`. Reject anything that isn't a strict
 * label so the value can't inject a host, path, or query (`/`, `@`, `:`, `.`
 * chains, etc.) into the derived baseURL.
 */
const AZURE_RESOURCE_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function assertValidAzureResourceName(resource: string): void {
  if (!AZURE_RESOURCE_NAME_RE.test(resource)) {
    throw new Error(
      `Invalid Azure resource name "${resource}" — must be a DNS label ` +
        `(letters/digits/hyphens, start and end alphanumeric, ≤63 chars)`,
    );
  }
}

export function configure(input: Config = {}) {
 // (SSRF guard): validate any user-supplied baseURL override before
 // building the route/endpoint.
  assertSafeUserBaseURL(input.baseURL);
 // Fail closed at config time when no usable endpoint can be derived.
  assertConfigured(input);

 // `resource` is UNTRUSTED (Options UI / settings sync / env var). Reject
 // anything that isn't a strict Azure resource-name DNS label so it cannot
 // inject a host/path/query into the derived baseURL — otherwise a value like
 // `evil.com/` would build `https://evil.com/.openai.azure.com` and exfiltrate
 // the `api-key` header (the transport SSRF recheck only blocks private IPs,
 // not attacker-controlled public hosts). See the audit's host-injection finding.
  const resource = input.resourceName ?? resolveEnvResource();
  if (resource !== undefined) {
    assertValidAzureResourceName(resource);
  }

  const apiVersion = input.apiVersion ?? (typeof process !== "undefined" ? process.env?.AZURE_OPENAI_API_VERSION : undefined) ?? DEFAULT_API_VERSION;
  const baseURL = input.baseURL ?? (resource ? `https://${resource}.openai.azure.com` : undefined);

 // Validate the FINAL baseURL (whether user-supplied OR resource-derived) so
 // the fetch URL is always checked, closing the gap where resource-derived
 // URLs previously bypassed the guard.
  assertSafeUserBaseURL(baseURL, "azure");

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

/**
 * Bridge to the agent's `LLMProvider` interface.
 *
 * Throws a clear error when Azure is selected but not properly configured
 * (neither `resourceName` nor `baseURL` provided, and no
 * `AZURE_OPENAI_RESOURCE_NAME` env var) — instead of silently falling back to
 * OpenAI's public endpoint. `configure()` performs the same check, so the
 * misconfiguration surfaces regardless of which entry point is used.
 */
export function toLLMProvider(config: Config & { model: string }): LLMProvider {
  assertConfigured(config);
  return toLLMProviderBridge({
    providerId: "azure",
    providerDisplayName: "Azure",
    model: config.model,
 // NOTE: `supportsVision` / `supportsStructuredOutput` default to `true`
 // here and are patched by the model catalog (`provider-bridge`) at resolve
 // time for models that lack these capabilities. This mirrors the documented
 // pattern in `anthropic.ts`; do NOT read this literal as "every Azure model
 // is vision-capable" — only catalog-known models keep it.
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: configure(config),
  });
}
