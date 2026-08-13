import {
  OPENAI_COMPAT_DEFAULT_BASE,
  AZURE_API_VERSION,
  checkCanonicalHost,
  parseModelCount,
  redact,
  assertSsrfSafe,
  getJson,
  providerLabel,
} from "./connection-test-utils";
import { PROVIDER_META } from "./providers";
import {
  getProviderCredentialStatus,
  testSelectedProviderConnection,
} from "./options-platform-client";

/** The result of a provider connection test. */
export interface ConnectionTestResult {
  /** Whether the connection (and, where applicable, the key) is valid. */
  ok: boolean;
  /** Round-trip latency in milliseconds (from call start to response). */
  latencyMs: number;
  /** Number of models the key can see, when the endpoint reports a list. */
  modelCount?: number;
  /** Human-readable, already-redacted message (≤240 chars on failure). */
  message: string;
  /** Exact model id accepted by the endpoint (may be auto-discovered). */
  model?: string;
  contextTokens?: number;
  slots?: number;
  vision?: boolean;
}

/** Inputs for {@link testProviderConnection}. */
interface ConnectionTestConfig {
  /** Provider id (openai, anthropic, gemini, ollama, azure, …). */
  provider: string;
  /** API key (Bearer / x-api-key / api-key). Omitted for Ollama. */
  apiKey: string;
  /** Base URL for OpenAI-compatible providers / Azure. Optional. */
  baseUrl?: string;
  /** Azure resource name (used to build the default Azure base URL). */
  resourceName?: string;
}

export interface PlatformConnectionTestConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  resourceName?: string;
  provenance: "user" | "injected";
  contextTokens?: number;
}

/** Trusted background connection test; no plaintext credential crosses the message boundary. */
export async function testSelectedModelConnection(
  config: PlatformConnectionTestConfig,
): Promise<ConnectionTestResult> {
  const credentialStatus = await getProviderCredentialStatus();
  const result = await testSelectedProviderConnection({
    version: 1,
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.resourceName ? { resourceName: config.resourceName } : {}),
    provenance: config.provenance,
    credential: credentialStatus.status === "ready" ? credentialStatus.reference : null,
    ...(config.contextTokens ? { contextTokens: config.contextTokens } : {}),
  });
  return {
    ok: result.ok,
    latencyMs: result.latencyMs,
    message: result.message,
    model: result.model,
    contextTokens: result.contextTokens,
    slots: result.slots,
    vision: result.vision,
  };
}

function rootOf(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl || fallback).replace(/\/+$/, "");
}

function okResult(count: number | undefined, latencyMs: number): ConnectionTestResult {
  return {
    ok: true,
    latencyMs,
    modelCount: count,
    message:
      count !== undefined
        ? `Connected (${latencyMs}ms, ${count} model${count === 1 ? "" : "s"} available)`
        : `Connected (${latencyMs}ms)`,
  };
}

/**
 * Validate a provider connection by listing models (or probing key presence).
 *
 * @returns a {@link ConnectionTestResult} describing success/failure, latency,
 *          and (where available) the model count the key can see.
 */
export async function testProviderConnection(
  cfg: ConnectionTestConfig,
): Promise<ConnectionTestResult> {
  const { provider, apiKey, baseUrl, resourceName } = cfg;
  const start = Date.now();

  const fail = (message: string, modelCount?: number): ConnectionTestResult => ({
    ok: false,
    latencyMs: Date.now() - start,
    message: redact(message, apiKey),
    modelCount,
  });

  try {
    let url: string;
    let headers: Record<string, string> = {};
    let needsKey = true;
    let count: number | undefined;

    switch (provider) {
      case "anthropic": {
        const root = rootOf(baseUrl, "https://api.anthropic.com/v1");
        url = `${root}/models`;
        headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
        const canonErr = checkCanonicalHost(provider, url, apiKey);
        if (canonErr) return fail(canonErr);
        break;
      }
      case "gemini": {
        const root = rootOf(baseUrl, "https://generativelanguage.googleapis.com/v1beta");
        url = `${root}/models?key=${encodeURIComponent(apiKey)}`;
        needsKey = false;
        const canonErr = checkCanonicalHost(provider, url, apiKey);
        if (canonErr) return fail(canonErr);
        break;
      }
      case "ollama": {
        const root = rootOf(baseUrl, "http://localhost:11434");
        url = `${root}/api/tags`;
        needsKey = false;
        break;
      }
      case "azure": {
        const root = rootOf(baseUrl, resourceName ? `https://${resourceName}.openai.azure.com` : "");
        if (!root) {
          return fail("Azure requires a baseUrl or resource name.");
        }
        const candidates: Array<{ url: string; headers: Record<string, string> }> = [
          { url: `${root}/openai/deployments?api-version=${AZURE_API_VERSION}`, headers: { "api-key": apiKey } },
          { url: `${root}/openai/models?api-version=${AZURE_API_VERSION}`, headers: { "api-key": apiKey } },
        ];
        let lastErr: unknown = null;
        for (const c of candidates) {
          try {
            const azCanon = checkCanonicalHost("azure", c.url, apiKey);
            if (azCanon) { lastErr = new Error(azCanon); continue; }
            await assertSsrfSafe(c.url);
            const body = await getJson(c.url, c.headers);
            count = parseModelCount(body);
            return okResult(count, Date.now() - start);
          } catch (e) {
            lastErr = e;
          }
        }
        return fail(lastErr instanceof Error ? lastErr.message : String(lastErr));
      }
      default: {
        if (!PROVIDER_META[provider]) {
          return fail(
            `Unknown provider "${provider}". Pick one from the provider list.`,
          );
        }
        const root = rootOf(
          baseUrl,
          PROVIDER_META[provider]?.defaultBaseUrl ||
            OPENAI_COMPAT_DEFAULT_BASE[provider] ||
            "",
        );
        if (!root) {
          return fail(
            `Provider "${provider}" requires a baseUrl (no default endpoint).`,
          );
        }
        url = `${root}/models`;
        headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        needsKey = PROVIDER_META[provider]?.needsKey ?? true;
        const canonErr = checkCanonicalHost(provider, url, apiKey);
        if (canonErr) return fail(canonErr);
        break;
      }
    }

    if (needsKey && !apiKey) {
      return fail(`${providerLabel(provider)} requires an API key.`);
    }

    await assertSsrfSafe(url);
    const body = await getJson(url, headers);
    count = parseModelCount(body);
    return okResult(count, Date.now() - start);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
