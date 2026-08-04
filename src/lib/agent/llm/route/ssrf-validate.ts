/**
 * URL validation functions for the SSRF guard.
 */

import type { SsrfCheckResult, SsrfProvenance } from "./ssrf-constants";
import {
  INTERNAL_TLD_SUFFIXES,
  LOCAL_PROVIDER_BASE_URLS,
  isCuratedLocalOrigin,
} from "./ssrf-constants";
import {
  isDangerousIpv4,
  isDangerousIpv6,
  isDangerousSinkIp,
  isLocalHostname,
  isUserLocalIp,
  isBlockedWebhookHost,
} from "./ssrf-ipv6";
import {
  baseUrlHost,
  dnsResolve,
  isLikelyHostname,
  parseBaseUrl,
  redactUrl,
} from "./ssrf-dns";

/**
 * Resolve provenance into an effective `exempt` boolean.
 */
function resolveExempt(provenance?: SsrfProvenance, allowLocalExemption = true): boolean {
  return provenance === "untrusted"
    ? false
    : provenance === "user-configured"
      ? true
      : allowLocalExemption;
}

// ─── LLM baseUrl validation ──────────────────────────────────────────────────

export function validateLlmBaseUrl(
  url: string,
  allowLocalExemption = true,
  provenance?: SsrfProvenance,
): SsrfCheckResult {
  const exempt = resolveExempt(provenance, allowLocalExemption);
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "baseUrl must be a non-empty string" };
  }
  const parsed = parseBaseUrl(url);
  if (!parsed) {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `scheme "${parsed.protocol}" is not allowed (only http/https): ${redactUrl(url)}`,
    };
  }
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };
  }
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  if (isDangerousSinkIp(normalizedHost)) {
    return {
      ok: false,
      reason: `host resolves to a private/loopback/link-local address: ${normalizedHost}`,
    };
  }
  const h = normalizedHost.toLowerCase().replace(/\.$/, "");
  if (INTERNAL_TLD_SUFFIXES.some((s) => h.endsWith(s))) {
    return {
      ok: false,
      reason: `host is a cloud-metadata/internal endpoint not allowed: ${redactUrl(url)}`,
    };
  }
  if (
    !exempt &&
    (isLocalHostname(normalizedHost) || isUserLocalIp(normalizedHost))
  ) {
    return {
      ok: false,
      reason: `host "${normalizedHost}" is a local endpoint not allowed for a non-user-configured baseUrl: ${redactUrl(url)}`,
    };
  }
  return { ok: true };
}

export async function resolveAndValidateLlmBaseUrl(
  url: string,
  allowLocalExemption = false,
  provenance?: SsrfProvenance,
): Promise<SsrfCheckResult> {
  const exempt = resolveExempt(provenance, allowLocalExemption);
  const base = validateLlmBaseUrl(url, exempt, provenance);
  if (!base.ok) return base;

  if (exempt && isCuratedLocalOrigin(url)) return { ok: true };

  let host = baseUrlHost(url);
  if (!host) return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };
  host = host.replace(/^\[|\]$/g, "");

  if (!isLikelyHostname(host)) return { ok: true };

  const outcome = await dnsResolve(host);
  if (outcome.kind === "unavailable") {
    if (provenance === "user-configured") {
      console.warn(
        `[ssrf] dnsResolve unavailable — allowing user-configured ${redactUrl(url)} ` +
          `(best-effort SSRF guard). Install the "dns" permission (dev channel) for full validation.`,
      );
      return { ok: true };
    }
    console.warn(
      `[ssrf] dnsResolve unavailable — refusing ${redactUrl(url)} (fail-closed SSRF ` +
        `guard). Without a resolver we cannot verify the real target IP; a ` +
        `hostname that resolves to a cloud-metadata / internal address would be a ` +
        `live SSRF exfil path.`,
    );
    return {
      ok: false,
      reason: `DNS resolver unavailable; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  if (outcome.kind === "error") {
    if (provenance === "user-configured") {
      console.warn(
        `[ssrf] dnsResolve errored for ${redactUrl(url)} — allowing user-configured ` +
          `(best-effort SSRF guard). Transient DNS failure; transport-layer guard will re-check.`,
      );
      return { ok: true };
    }
    console.warn(
      `[ssrf] dnsResolve errored for ${redactUrl(url)} — refusing (fail-closed SSRF ` +
        `guard). Verify the transport-layer guard still blocks unauthorized targets.`,
    );
    return {
      ok: false,
      reason: `DNS resolution for ${host} failed; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  if (outcome.ips.length === 0) {
    return {
      ok: false,
      reason: `DNS resolution for ${host} returned no addresses; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  for (const ip of outcome.ips) {
    const alwaysBlocked = ip.includes(":") ? isDangerousIpv6(ip) : isDangerousIpv4(ip);
    const localUntrusted = !exempt && isUserLocalIp(ip);
    if (alwaysBlocked || localUntrusted) {
      return {
        ok: false,
        reason: `host ${host} resolves to a private/loopback/link-local address (${ip}): ${redactUrl(url)}`,
      };
    }
  }
  return { ok: true };
}

export function isAllowedLlmBaseUrl(
  url: string,
  allowLocalExemption = true,
  provenance?: SsrfProvenance,
): boolean {
  const exempt = resolveExempt(provenance, allowLocalExemption);
  const res = validateLlmBaseUrl(url, false);
  if (res.ok) return true;
  if (!exempt) return false;
  try {
    const targetOrigin = new URL(url).origin;
    if (
      LOCAL_PROVIDER_BASE_URLS.some(
        (curated) => new URL(curated).origin === targetOrigin,
      )
    ) {
      return true;
    }
  } catch {
    // Invalid URL → not a curated local provider; leave it rejected.
  }
  return false;
}

// ─── Webhook URL validation ──────────────────────────────────────────────────

export function validateWebhookUrl(url: string, provenance?: SsrfProvenance): SsrfCheckResult {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "webhookUrl must be a non-empty string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `scheme "${parsed.protocol}" is not allowed (only http/https): ${redactUrl(url)}`,
    };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };
  }
  if (provenance === "user-configured" && (isLocalHostname(host) || isUserLocalIp(host))) {
    return { ok: true };
  }
  if (isBlockedWebhookHost(host)) {
    return {
      ok: false,
      reason: `host resolves to a private/metadata/link-local address: ${host}`,
    };
  }
  return { ok: true };
}

export async function resolveAndValidateWebhookUrl(
  url: string,
  provenance?: SsrfProvenance,
): Promise<SsrfCheckResult> {
  const isUser = provenance === "user-configured";
  const base = validateWebhookUrl(url, provenance);
  if (!base.ok) return base;

  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  if (!host) return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };

  if (!isLikelyHostname(host)) return { ok: true };

  const outcome = await dnsResolve(host);
  if (outcome.kind === "unavailable") {
    if (isUser) {
      console.warn(
        `[ssrf] dnsResolve unavailable — allowing user-configured ${redactUrl(url)} webhook ` +
          `(best-effort SSRF guard). Install the "dns" permission (dev channel) for full validation.`,
      );
      return { ok: true };
    }
    console.warn(
      `[ssrf] dnsResolve unavailable — refusing ${redactUrl(url)} webhook (fail-closed ` +
        `SSRF guard). A hostname that rebinds to an internal address would be a ` +
        `live exfil path.`,
    );
    return {
      ok: false,
      reason: `DNS resolver unavailable; refusing ${redactUrl(url)} webhook (fail-closed SSRF guard).`,
    };
  }
  if (outcome.kind === "error") {
    if (isUser) {
      console.warn(
        `[ssrf] dnsResolve errored for ${redactUrl(url)} — allowing user-configured webhook ` +
          `(best-effort SSRF guard). Transient DNS failure; transport-layer guard will re-check.`,
      );
      return { ok: true };
    }
    return {
      ok: false,
      reason: `DNS resolution for ${host} failed; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  if (outcome.ips.length === 0) {
    return {
      ok: false,
      reason: `DNS resolution for ${host} returned no addresses; refusing ${redactUrl(url)} webhook (fail-closed SSRF guard).`,
    };
  }
  for (const ip of outcome.ips) {
    if (isBlockedWebhookHost(ip)) {
      return {
        ok: false,
        reason: `host ${host} resolves to a private/loopback/link-local address (${ip}): ${redactUrl(url)}`,
      };
    }
  }
  return { ok: true };
}
