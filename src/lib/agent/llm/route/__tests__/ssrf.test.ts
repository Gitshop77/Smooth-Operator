/**
 * SSRF guard tests — verify the DNS-resolution path FAILS CLOSED for untrusted
 * `baseUrl` values (no resolver / resolution error) and that the curated
 * local-provider origins (Ollama / LiteLLM loopback) still pass for a
 * user-configured provenance.
 *
 * These tests intentionally hit the real `dnsResolve` code paths (no mocking of
 * the guard logic itself): a non-resolving `.invalid` hostname exercises the
 * `error` branch, and forcing absence of both resolvers exercises the
 * `unavailable` branch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveAndValidateLlmBaseUrl } from "../ssrf";

describe("resolveAndValidateLlmBaseUrl — fail closed", () => {
  // Snapshot any global resolvers so we can safely remove them and restore.
  const g = globalThis as Record<string, unknown>;
  const savedRequire = g.require;
  const savedChrome = g.chrome;

  afterEach(() => {
    g.require = savedRequire;
    g.chrome = savedChrome;
  });

  it("blocks an UNTRUSTED URL when DNS resolution errors (fail-closed)", async () => {
    const res = await resolveAndValidateLlmBaseUrl(
      "http://definitely-does-not-resolve-xyz.invalid/nope",
      false,
      "untrusted",
    );
    expect(res.ok).toBe(false);
  });

  it("blocks an UNTRUSTED URL when no DNS resolver is available (fail-closed)", async () => {
    // Remove both resolver sources so `dnsResolve` reports `unavailable`.
    g.require = undefined;
    g.chrome = undefined;
    const res = await resolveAndValidateLlmBaseUrl(
      "http://example.com/path",
      false,
      "untrusted",
    );
    expect(res.ok).toBe(false);
  });

  it("still allows a curated local Ollama origin for a user-configured provenance", async () => {
    const res = await resolveAndValidateLlmBaseUrl(
      "http://localhost:11434",
      true,
      "user-configured",
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a curated local origin for an UNTRUSTED provenance", async () => {
    const res = await resolveAndValidateLlmBaseUrl(
      "http://localhost:11434",
      false,
      "untrusted",
    );
    expect(res.ok).toBe(false);
  });
});
