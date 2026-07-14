/**
 * SSRF guard for LLM `baseUrl`.
 *
 * Verifies `validateLlmBaseUrl` allows normal public hostnames AND the user's
 * own self-hosted model infra (loopback `127.0.0.0/8`/`:1`, RFC1918
 * `10/8`/`172.16/12`/`192.168/16`, IPv6 ULA `fc00:/7`) — a user's Ollama /
 * LiteLLM server is their own host, not an SSRF target — while still rejecting
 * the genuine SSRF sinks: cloud-metadata / link-local `169.254.0.0/16` (+ IPv6
 * `fe80:/10`), unspecified `0.0.0.0/8` / `:`, and CGNAT `100.64.0.0/10`.
 */

import { describe, test, expect } from "vitest";
import { validateLlmBaseUrl, isAllowedLlmBaseUrl } from "../src/lib/agent/llm/route/ssrf";

function assertRejected(res: ReturnType<typeof validateLlmBaseUrl>, re: RegExp): void {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected rejection");
  expect(res.reason).toMatch(re);
}

describe("validateLlmBaseUrl (SSRF guard)", () => {
  test("allows a public hostname", () => {
    expect(validateLlmBaseUrl("https://api.openai.com/v1").ok).toBe(true);
    expect(validateLlmBaseUrl("http://api.groq.com/openai/v1").ok).toBe(true);
  });

  test("allows loopback hostnames (self-hosted model server)", () => {
    expect(validateLlmBaseUrl("http://localhost").ok).toBe(true);
    expect(validateLlmBaseUrl("http://localhost:11434/v1").ok).toBe(true);
  });

  test("allows an RFC1918 private address (10.0.0.0/8)", () => {
    expect(validateLlmBaseUrl("http://10.0.0.1/").ok).toBe(true);
  });

  test("allows an RFC1918 private address (192.168.0.0/16)", () => {
    expect(validateLlmBaseUrl("http://192.168.1.1/").ok).toBe(true);
  });

  test("rejects non-http(s) schemes", () => {
    assertRejected(validateLlmBaseUrl("file:///etc/passwd"), /is not allowed/i);
    assertRejected(validateLlmBaseUrl("ftp://169.254.169.254/"), /is not allowed/i);
  });

  test("rejects the cloud-metadata link-local address", () => {
    assertRejected(validateLlmBaseUrl("http://169.254.169.254/"), /link-local/i);
  });

  test("rejects the unspecified 0.0.0.0 address", () => {
    assertRejected(validateLlmBaseUrl("http://0.0.0.0/"), /private\/loopback\/link-local/i);
  });

 // Extra coverage beyond the required cases:
  test("rejects CGNAT / link-local / unspecified but allows loopback + RFC1918", () => {
    expect(validateLlmBaseUrl("http://172.16.5.5/").ok).toBe(true); // RFC1918 allowed
    expect(validateLlmBaseUrl("http://127.0.0.1/").ok).toBe(true); // loopback allowed
    assertRejected(validateLlmBaseUrl("http://100.64.0.1/"), /private\/loopback\/link-local/i);
  });

  test("IPv6: allows loopback / ULA / mapped-v4 but rejects link-local", () => {
    expect(validateLlmBaseUrl("http://[::1]/").ok).toBe(true); // loopback allowed
    expect(validateLlmBaseUrl("http://[fc00::1]/").ok).toBe(true); // ULA allowed
    expect(validateLlmBaseUrl("http://[::ffff:127.0.0.1]/").ok).toBe(true); // loopback mapped allowed
    expect(validateLlmBaseUrl("http://[::ffff:10.0.0.1]/").ok).toBe(true); // RFC1918 mapped allowed
    expect(validateLlmBaseUrl("http://[fe80::1]/").ok).toBe(false); // link-local blocked
 // Parse-layer defense-in-depth: IPv4-mapped cloud-metadata must be rejected
 // here, not only at the transport layer (isAllowedLlmBaseUrl).
    assertRejected(validateLlmBaseUrl("http://[::ffff:169.254.169.254]/"), /link-local|metadata/i);
    assertRejected(validateLlmBaseUrl("http://[::ffff:0.0.0.0]/"), /link-local|metadata/i);
  });

  test("rejects a malformed / empty URL", () => {
    assertRejected(validateLlmBaseUrl("not a url"), /invalid URL/i);
    assertRejected(validateLlmBaseUrl(""), /non-empty string/i);
  });
});

// ─── Transport-layer guard (the function actually invoked at fetch time) ───

describe("isAllowedLlmBaseUrl (transport-layer SSRF guard)", () => {
  test("allows public hostnames", () => {
    expect(isAllowedLlmBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isAllowedLlmBaseUrl("http://api.groq.com/openai/v1")).toBe(true);
  });

  test("allows curated local-provider loopback URLs (Ollama / LiteLLM) with default exemption", () => {
    expect(isAllowedLlmBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isAllowedLlmBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isAllowedLlmBaseUrl("http://localhost:4000/v1")).toBe(true);
    expect(isAllowedLlmBaseUrl("http://127.0.0.1:4000/v1")).toBe(true);
  });

  test("rejects genuine SSRF sinks even with the local exemption enabled", () => {
    expect(isAllowedLlmBaseUrl("http://169.254.169.254/")).toBe(false);
    expect(isAllowedLlmBaseUrl("http://0.0.0.0/")).toBe(false);
    expect(isAllowedLlmBaseUrl("http://100.64.0.1/")).toBe(false);
    expect(isAllowedLlmBaseUrl("file:///etc/passwd")).toBe(false);
  });

  test("curated loopback URLs are REJECTED when allowLocalExemption=false (HIGH-028: provenance flag closes the injected-loopback SSRF hole)", () => {
 // When `allowLocalExemption=false` (i.e. the baseUrl did NOT originate from
 // user configuration — e.g. injected via prompt injection / malicious
 // settings-sync), `isAllowedLlmBaseUrl` must apply the strict check and
 // reject even the curated local-provider loopback URLs, so an injected
 // `http://localhost:11434` can never reach the user's local Ollama / LiteLLM
 // server. Rejecting loopback here is the CORRECT security behavior.
    expect(isAllowedLlmBaseUrl("http://localhost:11434/v1", false)).toBe(false);
    expect(isAllowedLlmBaseUrl("http://127.0.0.1:11434/v1", false)).toBe(false);
    expect(isAllowedLlmBaseUrl("http://localhost:4000/v1", false)).toBe(false);
    expect(isAllowedLlmBaseUrl("http://127.0.0.1:4000/v1", false)).toBe(false);
 // A genuine sink is still rejected when the exemption is disabled.
    expect(isAllowedLlmBaseUrl("http://169.254.169.254/", false)).toBe(false);
  });

  test("IPv6 parity: transport guard rejects loopback/ULA/link-local/mapped regardless of exemption", () => {
 // Unlike the parse-layer `validateLlmBaseUrl` (which ALLOWS IPv6 loopback
 // `:1` and ULA `fc00:/7` as self-hosted infra), the transport-layer guard
 // only exempts the curated IPv4 local-provider origins (localhost /
 // 127.0.0.1). So every IPv6 variant — even loopback/ULA — is rejected, which
 // closes the gap where an IPv6 SSRF sink could slip through to `fetch`. Pin
 // this so a future change that adds IPv6 to the curated exemption is caught.
    const ipv6 = [
      "http://[::1]/v1",
      "http://[fc00::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://[::ffff:10.0.0.1]/v1",
      "http://[fe80::1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:0.0.0.0]/",
    ];
    for (const u of ipv6) {
      expect(isAllowedLlmBaseUrl(u)).toBe(false);
      expect(isAllowedLlmBaseUrl(u, false)).toBe(false);
    }
  });
});
