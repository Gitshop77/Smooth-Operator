/**
 * SSRF guard for LLM `baseUrl`.
 *
 * Verifies `validateLlmBaseUrl` rejects the dangerous address ranges the
 * service worker must never be steered at (cloud metadata, loopback, RFC1918,
 * CGNAT, link-local) while allowing normal public hostnames.
 */

import { describe, test, expect } from "vitest";
import { validateLlmBaseUrl } from "../src/lib/agent/llm/route/ssrf";

describe("validateLlmBaseUrl (SSRF guard)", () => {
  test("allows a public hostname", () => {
    expect(validateLlmBaseUrl("https://api.openai.com/v1").ok).toBe(true);
    expect(validateLlmBaseUrl("http://api.groq.com/openai/v1").ok).toBe(true);
  });

  test("rejects the cloud-metadata link-local address", () => {
    const res = validateLlmBaseUrl("http://169.254.169.254/");
    expect(res.ok).toBe(false);
  });

  test("rejects localhost", () => {
    const res = validateLlmBaseUrl("http://localhost");
    expect(res.ok).toBe(false);
  });

  test("rejects an RFC1918 private address (10.0.0.0/8)", () => {
    const res = validateLlmBaseUrl("http://10.0.0.1/");
    expect(res.ok).toBe(false);
  });

  test("rejects an RFC1918 private address (192.168.0.0/16)", () => {
    const res = validateLlmBaseUrl("http://192.168.1.1/");
    expect(res.ok).toBe(false);
  });

  test("rejects non-http(s) schemes", () => {
    expect(validateLlmBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateLlmBaseUrl("ftp://169.254.169.254/").ok).toBe(false);
  });

  test("rejects the unspecified 0.0.0.0 address", () => {
    const res = validateLlmBaseUrl("http://0.0.0.0/");
    expect(res.ok).toBe(false);
  });

  // Extra coverage beyond the required cases:
  test("rejects 172.16.0.0/12, 100.64.0.0/10 CGNAT, and 127.0.0.0/8", () => {
    expect(validateLlmBaseUrl("http://172.16.5.5/").ok).toBe(false);
    expect(validateLlmBaseUrl("http://100.64.0.1/").ok).toBe(false);
    expect(validateLlmBaseUrl("http://127.0.0.1/").ok).toBe(false);
  });

  test("rejects IPv6 loopback / link-local / ULA / mapped-v4", () => {
    expect(validateLlmBaseUrl("http://[::1]/").ok).toBe(false);
    expect(validateLlmBaseUrl("http://[fe80::1]/").ok).toBe(false);
    expect(validateLlmBaseUrl("http://[fc00::1]/").ok).toBe(false);
    expect(validateLlmBaseUrl("http://[::ffff:127.0.0.1]/").ok).toBe(false);
    expect(validateLlmBaseUrl("http://[::ffff:10.0.0.1]/").ok).toBe(false);
  });

  test("rejects a malformed / empty URL", () => {
    expect(validateLlmBaseUrl("not a url").ok).toBe(false);
    expect(validateLlmBaseUrl("").ok).toBe(false);
  });
});
