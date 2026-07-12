/**
 * SSRF guard for LLM `baseUrl`.
 *
 * Verifies `validateLlmBaseUrl` allows normal public hostnames AND the user's
 * own self-hosted model infra (loopback `127.0.0.0/8`/`::1`, RFC1918
 * `10/8`/`172.16/12`/`192.168/16`, IPv6 ULA `fc00::/7`) — a user's Ollama /
 * LiteLLM server is their own host, not an SSRF target — while still rejecting
 * the genuine SSRF sinks: cloud-metadata / link-local `169.254.0.0/16` (+ IPv6
 * `fe80::/10`), unspecified `0.0.0.0/8` / `::`, and CGNAT `100.64.0.0/10`.
 */

import { describe, test, expect } from "vitest";
import { validateLlmBaseUrl } from "../src/lib/agent/llm/route/ssrf";

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
    expect(validateLlmBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateLlmBaseUrl("ftp://169.254.169.254/").ok).toBe(false);
  });

  test("rejects the cloud-metadata link-local address", () => {
    const res = validateLlmBaseUrl("http://169.254.169.254/");
    expect(res.ok).toBe(false);
  });

  test("rejects the unspecified 0.0.0.0 address", () => {
    const res = validateLlmBaseUrl("http://0.0.0.0/");
    expect(res.ok).toBe(false);
  });

  // Extra coverage beyond the required cases:
  test("rejects CGNAT / link-local / unspecified but allows loopback + RFC1918", () => {
    expect(validateLlmBaseUrl("http://172.16.5.5/").ok).toBe(true); // RFC1918 allowed
    expect(validateLlmBaseUrl("http://127.0.0.1/").ok).toBe(true); // loopback allowed
    expect(validateLlmBaseUrl("http://100.64.0.1/").ok).toBe(false); // CGNAT blocked
  });

  test("IPv6: allows loopback / ULA / mapped-v4 but rejects link-local", () => {
    expect(validateLlmBaseUrl("http://[::1]/").ok).toBe(true); // loopback allowed
    expect(validateLlmBaseUrl("http://[fc00::1]/").ok).toBe(true); // ULA allowed
    expect(validateLlmBaseUrl("http://[::ffff:127.0.0.1]/").ok).toBe(true); // loopback mapped allowed
    expect(validateLlmBaseUrl("http://[::ffff:10.0.0.1]/").ok).toBe(true); // RFC1918 mapped allowed
    expect(validateLlmBaseUrl("http://[fe80::1]/").ok).toBe(false); // link-local blocked
  });

  test("rejects a malformed / empty URL", () => {
    expect(validateLlmBaseUrl("not a url").ok).toBe(false);
    expect(validateLlmBaseUrl("").ok).toBe(false);
  });
});
