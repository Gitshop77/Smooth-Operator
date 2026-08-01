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

import { apiKeyAuth, type ProviderAuthOption } from "../route/auth";
import { Endpoint } from "../route/endpoint";
import { Framing } from "../route/framing";
import { make } from "../route/client";
import * as OpenAIChat from "../protocols/openai-chat";
import type { LLMProvider } from "../provider";
import { toLLMProvider as toLLMProviderBridge } from "../provider-bridge";
import { encodeModelIdForUrl } from "../modelId";
import { assertSafeUserBaseURL } from "./openai-compatible-profile";
import { isCuratedLocalOriginUrl } from "./openai";
import type { SsrfProvenance } from "../route/ssrf";

const id = "azure";

/** Default Azure OpenAI API version (recent stable). */
const DEFAULT_API_VERSION = "2024-10-21";

/**
 * Azure `api-version` is untrusted (Options UI / settings sync / env var) and
 * flows straight into the request URL's query string. Restrict it to the same
 * strict allowlist shape as a real Azure API version so it cannot inject extra
 * query parameters (e.g. `2024-10-21&evil=1`) or steer the request elsewhere.
 */
const AZURE_API_VERSION_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(-(preview|beta))?$/;

function assertValidAzureApiVersion(apiVersion: string): void {
  if (!AZURE_API_VERSION_RE.test(apiVersion)) {
    throw new Error(
      `Invalid Azure API version "${apiVersion}" — must match YYYY-MM-DD or YYYY-MM-DD-(preview|beta)`,
    );
  }
}

type Config = {
  baseURL?: string;
  resourceName?: string;
  apiVersion?: string;
  // When true (user-configured provenance) the curated-local-provider loopback
  // exemption is honored; otherwise loopback / RFC1918 / ULA are rejected.
  allowLocalExemption?: boolean;
} & ProviderAuthOption<"optional">;

const auth = (options: ProviderAuthOption<"optional">) =>
  apiKeyAuth(options, "AZURE_OPENAI_API_KEY", "api-key");

/** Read the Azure env-var config once (guarded for non-Node contexts). */
function resolveAzureEnv(): { resource?: string; apiVersion?: string } {
  if (typeof process === "undefined") return {};
  return {
    resource: process.env?.AZURE_OPENAI_RESOURCE_NAME,
    apiVersion: process.env?.AZURE_OPENAI_API_VERSION,
  };
}

/**
 * Throw a clear error when Azure is selected but not properly configured
 * (neither `resourceName` nor `baseURL` provided, and no
 * `AZURE_OPENAI_RESOURCE_NAME` env var). This surfaces the misconfiguration
 * at config time — whether via `configure()` or `toLLMProvider()` — instead
 * of silently producing an empty/relative URL that fails opaquely at request
 * time.
 */
function assertConfigured(input: Config, envResource: string | undefined): void {
  if (!input.resourceName && !input.baseURL && !envResource) {
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
  const env = resolveAzureEnv();
  // Fail closed at config time when no usable endpoint can be derived.
  assertConfigured(input, env.resource);

 // `resource` is UNTRUSTED (Options UI / settings sync / env var). Reject
 // anything that isn't a strict Azure resource-name DNS label so it cannot
 // inject a host/path/query into the derived baseURL — otherwise a value like
 // `evil.com/` would build `https://evil.com/.openai.azure.com` and exfiltrate
 // the `api-key` header (the transport SSRF recheck only blocks private IPs,
  // not attacker-controlled public hosts).
  const resource = input.resourceName ?? env.resource;
  if (resource !== undefined) {
    assertValidAzureResourceName(resource);
  }

  const apiVersion = input.apiVersion ?? env.apiVersion ?? DEFAULT_API_VERSION;
  assertValidAzureApiVersion(apiVersion);
  const baseURL = input.baseURL ?? (resource ? `https://${resource}.openai.azure.com` : undefined);

 // Validate the FINAL baseURL (whether user-supplied OR resource-derived) so
 // the fetch URL is always checked, closing the gap where resource-derived
 // URLs previously bypassed the guard. Forward the curated-local exemption flag
 // (only true for a user-configured baseURL that exactly matches a curated
 // local origin) so the loopback/RFC1918 exemption can never widen trust for a
 // non-curated Azure baseURL — mirroring the openai.ts facade.
  const exemption = !!input.allowLocalExemption && isCuratedLocalOriginUrl(baseURL);
  assertSafeUserBaseURL(baseURL, "azure", exemption);
  // Derive SSRF provenance from allowLocalExemption: when the user explicitly
  // configured this provider (allowLocalExemption=true), provenance is
  // "user-configured"; otherwise "untrusted". This ensures the async DNS
  // validation in transport-http.ts uses the correct trust level.
  const provenance: SsrfProvenance = input.allowLocalExemption ? "user-configured" : "untrusted";

  return {
    id,
    model: (modelID: string) => {
 // Azure URL: /openai/deployments/{deployment}/chat/completions?api-version={version}
 // `encodeModelIdForUrl(modelID)` keeps normal deployment names identical
 // but prevents a malicious/garbage id from injecting path separators into
 // the request URL, and throws on structurally-invalid ids.
      const route = make({
        // Fold the model id into the route id so distinct deployments register
        // under distinct registry keys and a later model() call can't clobber
        // the earlier model's route (per-model deployment URLs differ).
        id: `azure-openai:${encodeModelIdForUrl(modelID)}`,
        provider: id,
        protocol: OpenAIChat.protocol,
        endpoint: Endpoint.path(`/openai/deployments/${encodeModelIdForUrl(modelID)}/chat/completions`, {
          baseURL,
          query: { "api-version": apiVersion },
        }),
        auth: auth(input),
        framing: Framing.sse,
        provenance,
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
