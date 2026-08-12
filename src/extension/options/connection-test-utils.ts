import { redactKeyLeak } from "@/extension/shared";
import { PROVIDER_META } from "./providers";
import { profiles } from "../../lib/agent/llm/providers/openai-compatible-profile";
import {
  resolveAndValidateLlmBaseUrl,
  validateLlmBaseUrl,
} from "../../lib/agent/llm/route/ssrf";

/**
 * Default base URLs for the OpenAI-compatible families. Only consulted when the
 * user hasn't supplied a `baseUrl`.
 *
 * The map is DERIVED from the runtime `profiles` table (`byProvider` in
 * `openai-compatible-profile.ts`) — the source `buildProvider`'s
 * `canonicalLlmHost` reads — plus the dedicated `openai` case (which has no
 * profile entry). Deriving instead of hand-maintaining keeps the two sides in
 * lockstep: a provider added to the profiles table is confined here
 * automatically (baseten, deepinfra, fireworks, …), and loopback-only profiles
 * (ollama, litellm) get their canonical hosts too, exactly like the runtime.
 */
export const OPENAI_COMPAT_DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  ...Object.fromEntries(
    Object.values(profiles).map((p) => [p.provider, p.baseURL]),
  ),
};

/** Azure OpenAI API version used for the deployments/models listing. */
export const AZURE_API_VERSION = "2024-02-15-preview";

/**
 * Canonical host an INJECTED/user baseUrl may target for a given provider
 * (mirrors `buildProvider`'s `canonicalLlmHost`). A public baseUrl must match
 * the provider's own host so the user's API key (sent as `Bearer`) can't be
 * exfiltrated to an attacker-controlled endpoint. Mirrors `canonicalLlmHost`
 * exactly:
 *  - `OPENAI_COMPAT_DEFAULT_BASE` is derived from the runtime `profiles` table
 *    (`byProvider`): every OpenAI-compatible family with a static default host;
 *  - the switch below mirrors `canonicalLlmHost`'s dedicated cases;
 *  - suffix entries allow the exact canonical host or a DOTTED subdomain
 *    boundary at the call site (`host === canon.host ||
 *    host.endsWith("." + canon.host)`), exactly like the runtime — allows
 *    `anthropic.com` / `proxy.anthropic.com` / any `{resource}.openai.azure.com`,
 *    rejects `evilanthropic.com` / `evilgoogleapis.com` which merely end with
 *    the canonical host;
 *  - tail (catalog-derived) providers → `null`, exactly like `canonicalLlmHost`'s
 *    `default` branch. `checkCanonicalHost` treats `null` as a REJECT, mirroring
 *    the runtime's `allowed = canon !== null && …` — the options side must NOT
 *    invent a canonical host from the catalog `api` URL, and must not pass a
 *    config the runtime refuses.
 * Local/loopback hosts are governed by the SSRF guard, not host confinement.
 */
function canonicalHost(provider: string): { host: string; suffix?: boolean } | null {
  const fromBase = OPENAI_COMPAT_DEFAULT_BASE[provider];
  if (fromBase) return { host: new URL(fromBase).host };
  switch (provider) {
    case "anthropic": return { host: "anthropic.com", suffix: true };
    case "gemini": return { host: "generativelanguage.googleapis.com" };
    case "google": return { host: "googleapis.com", suffix: true };
    case "azure": return { host: "openai.azure.com", suffix: true };
    default: return null;
  }
}

/**
 * Returns an error message if `url` is a PUBLIC, keyed endpoint that does NOT
 * target the provider's canonical host (key-exfiltration guard). Returns `null`
 * when confinement does not apply (no key, local/loopback endpoint, or a URL
 * the SSRF guard already rejects). Mirrors `buildProvider`'s canonical-host
 * confinement: like the runtime, a provider with NO canonical host rejects any
 * non-local keyed baseUrl (the runtime computes `allowed = canon !== null &&
 * …`, so `null` means reject).
 */
export function checkCanonicalHost(provider: string, url: string, apiKey: string): string | null {
  if (!apiKey) return null;
  const canon = canonicalHost(provider);
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { return null; }
  if (!validateLlmBaseUrl(url, false).ok) return null;
  const denied = () =>
    `baseUrl must target the canonical host for provider "${provider}" to protect your API key from exfiltration.`;
  if (canon === null) return denied();
  const allowed = canon.suffix
    ? hostname === canon.host || hostname.endsWith("." + canon.host)
    : hostname === canon.host;
  if (!allowed) return denied();
  return null;
}

/**
 * Parse a model count out of a provider's models-list response. Providers use
 * different envelope shapes, so we probe the common ones:
 *  - OpenAI-compatible / Azure: `{ data: [...] }`
 *  - Anthropic: `{ data: [...] }`
 *  - Gemini: `{ models: [...] }`
 *  - Ollama (tags): `{ models: [...] }`
 * Returns `undefined` when no recognizable list is present (we still report a
 * successful connection — we just can't cite a count).
 */
export function parseModelCount(payload: unknown): number | undefined {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data.length;
    if (Array.isArray(obj.models)) return obj.models.length;
    if (Array.isArray(obj.results)) return obj.results.length;
  }
  return undefined;
}

/**
 * Redact the API key from a message and truncate to a UI-safe length.
 * We re-run `redactKeyLeak` AND strip the raw key substring so a secret that
 * appears anywhere in the (possibly unstructured) provider error is masked.
 */
export function redact(message: string, apiKey: string): string {
  let out = redactKeyLeak(message);
  if (apiKey) {
    out = out.split(apiKey).join("[REDACTED]");
  }
  return out.slice(0, 240);
}

/** Run the project's SSRF guard on a fetch URL (user-configured provenance). */
export async function assertSsrfSafe(url: string): Promise<void> {
  const res = await resolveAndValidateLlmBaseUrl(url, true, "user-configured");
  if (!res.ok) {
    throw new Error(res.reason || "URL rejected by SSRF guard");
  }
}

const CONNECTION_RESPONSE_BYTES = 1024 * 1024;
const CONNECTION_ERROR_PREVIEW_BYTES = 1024;
const CONNECTION_CLEANUP_DEADLINE_MS = 50;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Test Connection aborted", "AbortError");
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Stream cancellation is cleanup, not part of the provider result. A browser
 * implementation (or test double) is allowed to leave cancel() pending while
 * its underlying source settles, so never let that promise extend the Test
 * Connection deadline indefinitely.
 */
async function cancelWithDeadline(cancel: () => Promise<unknown>): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, CONNECTION_CLEANUP_DEADLINE_MS);
    void Promise.resolve().then(cancel).catch(() => {}).then(finish);
  });
}

/** Return a trustworthy, bounded integer Content-Length or null when absent/malformed. */
function declaredContentLength(response: Response): number | null {
  const raw = response.headers?.get?.("content-length");
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readBoundedBody(
  response: Response,
  byteCap: number,
  signal: AbortSignal,
): Promise<{ text: string; tooLarge: boolean }> {
  const declared = declaredContentLength(response);
  const body = response.body;
  if (declared !== null && declared > byteCap) {
    if (body) {
      await cancelWithDeadline(() => body.cancel());
    }
    return { text: "", tooLarge: true };
  }

  if (!body) {
    if (typeof response.text !== "function") return { text: "", tooLarge: false };
    // Real fetch responses expose readable bodies. A bodyless text() fallback
    // is therefore primarily a platform/test compatibility seam, and may only
    // be used when a valid declared size proves the read is within this
    // caller's budget. Missing/malformed lengths fail closed before text()
    // could buffer an unbounded payload.
    if (declared === null) {
      throw new Error("response body unavailable for bounded read");
    }
    if (declared === 0) return { text: "", tooLarge: false };
    const text = await withAbort(response.text(), signal);
    return {
      text,
      tooLarge: new TextEncoder().encode(text).byteLength > byteCap,
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let tooLarge = false;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      const remaining = byteCap - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.slice(0, remaining), { stream: true });
        tooLarge = true;
        await cancelWithDeadline(() => reader.cancel());
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await cancelWithDeadline(() => reader.cancel());
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { text, tooLarge };
}

/**
 * Perform one authenticated `GET` to `url` and return the parsed JSON body.
 * Throws on network error or a non-2xx status (with a redacted, status-aware
 * message). The caller owns latency measurement + redaction of `apiKey`.
 */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const deadline = AbortSignal.timeout(10_000);
  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: deadline,
  });
  if (res.type === "opaqueredirect") {
    throw new Error("redirect refused by Test Connection");
  }
  if (!res.ok) {
    const body = await readBoundedBody(res, CONNECTION_ERROR_PREVIEW_BYTES, deadline);
    if (body.tooLarge) throw new Error(`HTTP ${res.status}: response body too large`);
    let detail = body.text.slice(0, 200);
    try {
      const parsed = JSON.parse(body.text) as Record<string, unknown>;
      detail = typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : JSON.stringify(parsed).slice(0, 200);
    } catch {
      // A plain-text provider error is already a useful bounded preview.
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`HTTP ${res.status}${suffix}`);
  }

  if (res.body || typeof res.text === "function") {
    const body = await readBoundedBody(res, CONNECTION_RESPONSE_BYTES, deadline);
    if (body.tooLarge) {
      throw new Error(`response body too large: exceeded ${CONNECTION_RESPONSE_BYTES} bytes`);
    }
    if (!body.text.trim()) return {};
    try {
      return JSON.parse(body.text) as unknown;
    } catch {
      return {};
    }
  }

  // Some browser/test response shims expose only json(). Keep that compatible,
  // but do not turn a body deadline into the historical empty-success result.
  try {
    return await withAbort(res.json(), deadline);
  } catch (error) {
    if (deadline.aborted) throw error;
    return {};
  }
}

/**
 * Human label for a provider id in messages. Derived from `PROVIDER_META`
 * (which owns the canonical labels) so it can't drift from the dropdown.
 */
export function providerLabel(provider: string): string {
  return PROVIDER_META[provider]?.label ?? provider;
}
