/**
 * Regression tests for the SSRF guard's IPv6 mapped/embedded vectors and the
 * async resolve-and-validate fail-closed / fail-open behavior
 * (`src/lib/agent/llm/route/ssrf.ts`).
 *
 * These pin the exact vectors the guard exists to stop:
 * - the `::ffff:0:0/96` three-group mapped form plus NAT64 / 6to4 / Teredo
 *   embedded dangerous-IPv4 blocking (cloud-metadata),
 * - the strict-provenance rejection of mapped loopback / RFC1918 endpoints,
 * - `resolveAndValidateLlmBaseUrl` / `resolveAndValidateWebhookUrl` outcome
 *   branches: fail-CLOSED on a DNS lookup error, and fail-OPEN-with-warning
 *   when no resolver is available (only for a trusted / local-exempt caller).
 */
import { describe, test, expect, afterEach, vi } from "vitest";
import {
  validateLlmBaseUrl,
  validateWebhookUrl,
  resolveAndValidateLlmBaseUrl,
  resolveAndValidateWebhookUrl,
} from "@/lib/agent/llm/route/ssrf";

type ChromeShim = {
  dns?: { resolve?: (h: string, cb: (r: { addresses?: string[] }) => void) => void };
  runtime?: { lastError?: unknown };
};

const g = globalThis as unknown as { chrome?: ChromeShim; require?: unknown };

afterEach(() => {
  delete g.chrome;
  vi.restoreAllMocks();
});

/** Install a chrome.dns.resolve stub returning the given IPs (no lastError). */
function mockDnsResolved(ips: string[]): void {
  g.chrome = {
    runtime: { lastError: undefined },
    dns: { resolve: (_h, cb) => cb({ addresses: ips }) },
  };
}

/** Install a chrome.dns.resolve stub that reports a lookup error. */
function mockDnsError(): void {
  g.chrome = {
    runtime: { lastError: { message: "NXDOMAIN" } },
    dns: { resolve: (_h, cb) => cb({}) },
  };
}

describe("embedded IPv6 SSRF classification (cloud metadata)", () => {
  test.each([
    "http://[::ffff:0:a9fe:a9fe]",   // ::ffff:0:0/96 mapped 169.254.169.254
    "http://[64:ff9b::a9fe:a9fe]",   // NAT64 169.254.169.254
    "http://[2002:a9fe:a9fe::]",     // 6to4 169.254.169.254
    "http://[2001:0:0:0:0:0:a9fe:a9fe]", // Teredo 169.254.169.254
  ])("validateLlmBaseUrl blocks metadata via %s", (url) => {
    expect(validateLlmBaseUrl(url).ok).toBe(false);
  });

  test.each([
    "http://[::ffff:0:a9fe:a9fe]",
    "http://[64:ff9b::a9fe:a9fe]",
    "http://[2002:a9fe:a9fe::]",
    "http://[2001:0:0:0:0:0:a9fe:a9fe]",
  ])("validateWebhookUrl blocks metadata via %s", (url) => {
    expect(validateWebhookUrl(url).ok).toBe(false);
  });
});

describe("strict-provenance rejection of mapped loopback / RFC1918 (#1 bypass)", () => {
  test("mapped loopback 127.0.0.1 is rejected when provenance is untrusted", () => {
    // ::ffff:0:7f00:1 === 127.0.0.1
    expect(validateLlmBaseUrl("http://[::ffff:0:7f00:1]:8080", false).ok).toBe(false);
  });

  test("mapped RFC1918 192.168.1.1 is rejected when provenance is untrusted", () => {
    // ::ffff:0:c0a8:0101 === 192.168.1.1
    expect(validateLlmBaseUrl("http://[::ffff:0:c0a8:0101]", false).ok).toBe(false);
  });

  test("the same mapped-local URLs stay ALLOWED for a user-configured baseUrl", () => {
    // allowLocalExemption defaults to true — self-hosted local infra is allowed.
    expect(validateLlmBaseUrl("http://[::ffff:0:7f00:1]:8080", true).ok).toBe(true);
    expect(validateLlmBaseUrl("http://[::ffff:0:c0a8:0101]", true).ok).toBe(true);
  });
});

describe("resolveAndValidateLlmBaseUrl DNS outcome branches", () => {
  test("resolver error → fail CLOSED", async () => {
    mockDnsError();
    const res = await resolveAndValidateLlmBaseUrl("http://rebind.example.com");
    expect(res.ok).toBe(false);
  });

  test("resolved to internal IP → rejected when provenance untrusted", async () => {
    mockDnsResolved(["169.254.169.254"]);
    const res = await resolveAndValidateLlmBaseUrl("http://rebind.example.com", false);
    expect(res.ok).toBe(false);
  });

  test("resolved to public IP → allowed", async () => {
    mockDnsResolved(["93.184.216.34"]);
    const res = await resolveAndValidateLlmBaseUrl("http://api.example.com");
    expect(res.ok).toBe(true);
  });

  test("no resolver + untrusted provenance → fail CLOSED", async () => {
    const savedRequire = g.require;
    delete g.require;
    try {
      const res = await resolveAndValidateLlmBaseUrl("http://rebind.example.com", false);
      expect(res.ok).toBe(false);
    } finally {
      if (savedRequire !== undefined) g.require = savedRequire;
    }
  });

  test("no resolver + local-exempt provenance → fail CLOSED (guard never weakens for an unverifiable target)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const savedRequire = g.require;
    delete g.require;
    try {
      const res = await resolveAndValidateLlmBaseUrl("http://api.example.com", true);
      // No DNS resolver is available in this runtime, so the guard FAILS CLOSED
      // (with a warning) even for a user-configured provenance — an unverifiable
      // target IP must never be trusted.
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected rejection");
      expect(res.reason).toMatch(/DNS resolver unavailable/i);
      expect(warn).toHaveBeenCalled();
    } finally {
      if (savedRequire !== undefined) g.require = savedRequire;
    }
  });
});

describe("resolveAndValidateWebhookUrl DNS outcome branches", () => {
  test("resolver error → fail CLOSED", async () => {
    mockDnsError();
    const res = await resolveAndValidateWebhookUrl("http://rebind.example.com/hook");
    expect(res.ok).toBe(false);
  });

  test("resolved to metadata IP → rejected", async () => {
    mockDnsResolved(["169.254.169.254"]);
    const res = await resolveAndValidateWebhookUrl("http://rebind.example.com/hook");
    expect(res.ok).toBe(false);
  });
});
