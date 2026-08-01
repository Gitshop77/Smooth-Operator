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

import { describe, test, expect, afterEach } from "vitest";
import { validateLlmBaseUrl, isAllowedLlmBaseUrl, validateWebhookUrl, resolveAndValidateLlmBaseUrl } from "../src/lib/agent/llm/route/ssrf";
import { redactUrl } from "../src/lib/agent/llm/route/url-redact";

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

  test("NAT64 + IPv4-mapped cloud-metadata forms are rejected", () => {
    // NAT64 (RFC 6052) `64:ff9b::/96`: the embedded IPv4 is reached through the
    // NAT64 gateway, so `64:ff9b::169.254.169.254` reaches cloud metadata.
    assertRejected(validateLlmBaseUrl("http://[64:ff9b::169.254.169.254]/"), /link-local|metadata/i);
    // IPv4-mapped `::ffff:<ipv4>` to the metadata address.
    assertRejected(validateLlmBaseUrl("http://[::ffff:169.254.169.254]/"), /link-local|metadata/i);
  });

  test("Teredo / 6to4 IPv6 forms embedding link-local cloud-metadata are rejected", () => {
    // RFC 4380 stores the Teredo client IPv4 XORed with 0xFFFFFFFF, so the
    // Teredo encoding of 169.254.169.254 (a9fe:a9fe) is `2001::5601:5601`.
    // The de-obfuscated reading must be rejected at BOTH the config layer and
    // the transport layer (the obfuscated form previously passed both).
    assertRejected(validateLlmBaseUrl("http://[2001::5601:5601]/"), /link-local|metadata/i);
    expect(isAllowedLlmBaseUrl("http://[2001::5601:5601]/")).toBe(false);
    // 6to4 (RFC 3056) `2002::/16` with the embedded IPv4 in groups[1]:groups[2].
    assertRejected(validateLlmBaseUrl("http://[2002:a9fe:a9fe::]/"), /link-local|metadata/i);
    expect(isAllowedLlmBaseUrl("http://[2002:a9fe:a9fe::]/")).toBe(false);
  });

  test("Teredo-encoded loopback (2001::80ff:fffe = 127.0.0.1 XOR 0xFFFFFFFF) is a self-hosted local endpoint", () => {
    // Directional pin for the de-obfuscation: `80ff:fffe ^ ffff:ffff` reads back
    // to 127.0.0.1, which the parse layer allows as user-local infra (the
    // transport gate still rejects all IPv6 — pinned in the transport section).
    expect(validateLlmBaseUrl("http://[2001::80ff:fffe]/").ok).toBe(true);
  });

  test("zone-id IPv6 (fe80::1%eth0) is rejected", () => {
    // A link-local address with a `%zone` suffix must still be rejected (as a
    // link-local sink or an unparseable literal) — never allowed to fetch.
    expect(validateLlmBaseUrl("http://[fe80::1%25eth0]/").ok).toBe(false);
    expect(isAllowedLlmBaseUrl("http://[fe80::1%25eth0]/")).toBe(false);
  });

  test("rejects cloud-metadata / internal hostnames", () => {
    assertRejected(validateLlmBaseUrl("http://metadata.google.internal/"), /internal|metadata/i);
  });

  test("deprecated IPv4-compatible form (::a.b.c.d) catches an embedded cloud-metadata IPv4", () => {
    // The WHATWG URL parser canonicalizes the deprecated IPv4-compatible form
    // `http://[::169.254.169.254]/` to the hex `::a9fe:a9fe`; the IPv6 classifier
    // must still read the embedded IPv4 (169.254.169.254) off the last two groups
    // and reject it as link-local cloud metadata — at BOTH the parse layer and
    // the transport layer. This pins the branch so a future regression that
    // drops the deprecated-form handling silently reopens the cloud-metadata SSRF
    // path.
    assertRejected(validateLlmBaseUrl("http://[::169.254.169.254]/"), /link-local|metadata/i);
    expect(isAllowedLlmBaseUrl("http://[::169.254.169.254]/")).toBe(false);
    // The same deprecated form embedding a *loopback* IPv4 (self-hosted infra) is
    // NOT a sink, so the branch must allow it — confirming the check keys on the
    // embedded IPv4 being genuinely dangerous rather than rejecting the whole
    // `::a.b.c.d` shape.
    expect(validateLlmBaseUrl("http://[::127.0.0.1]/").ok).toBe(true);
    expect(isAllowedLlmBaseUrl("http://[::127.0.0.1]/")).toBe(true);
  });

  test("still allows a user-configured loopback local-provider URL", () => {
    expect(validateLlmBaseUrl("http://localhost:11434/v1").ok).toBe(true);
  });
});

// ─── Completion-webhook guard (loops back allowed, internal/single-label blocked) ───

describe("validateWebhookUrl (webhook SSRF guard)", () => {
  test("rejects single-label hostnames (can resolve to unexpected local targets)", () => {
    assertRejected(validateWebhookUrl("http://router/"), /private\/metadata\/link-local/i);
  });

  test("rejects cloud-metadata / internal hostnames", () => {
    assertRejected(validateWebhookUrl("http://metadata.google.internal/"), /private\/metadata\/link-local/i);
  });

  test("allows a loopback webhook relay (self-hosted dev notification)", () => {
    expect(validateWebhookUrl("http://localhost:8080/hook").ok).toBe(true);
  });

  test("rejects IPv6 embedded-IPv4 cloud-metadata forms (NAT64 / mapped / Teredo / 6to4 / IPv4-compatible)", () => {
    expect(validateWebhookUrl("http://[64:ff9b::169.254.169.254]/hook").ok).toBe(false);
    expect(validateWebhookUrl("http://[2002:a9fe:a9fe::]/hook").ok).toBe(false);
    // RFC 4380 de-obfuscated Teredo encoding of 169.254.169.254 must be
    // blocked by the webhook path too (parity with the LLM path).
    expect(validateWebhookUrl("http://[2001::5601:5601]/hook").ok).toBe(false);
    expect(validateWebhookUrl("http://[::ffff:169.254.169.254]/hook").ok).toBe(false);
    expect(validateWebhookUrl("http://[::169.254.169.254]/hook").ok).toBe(false);
  });

  test("allows IPv6 loopback and a public IPv6 webhook", () => {
    expect(validateWebhookUrl("http://[::1]:8080/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://[2606:4700:4700::1111]/hook").ok).toBe(true);
  });
});

// ─── LLM/webhook SSRF parity ──────────────────────────────────────────────────
//
// Every embedded-IPv4 cloud-metadata form the LLM path blocks must ALSO be
// blocked by the webhook path, so the two classifiers cannot silently diverge.

describe("IPv6 embedded-IPv4 SSRF classifier parity (LLM vs webhook)", () => {
  const metadataForms = [
    "http://[64:ff9b::169.254.169.254]/",
    "http://[2002:a9fe:a9fe::]/",
    "http://[2001::5601:5601]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::169.254.169.254]/",
  ];

  test("every metadata form blocked by the LLM path is also blocked by the webhook path", () => {
    for (const u of metadataForms) {
      expect(validateLlmBaseUrl(u).ok).toBe(false);
      expect(validateWebhookUrl(u).ok).toBe(false);
    }
  });

  test("both paths allow IPv6 loopback and a public IPv6 address", () => {
    for (const u of ["http://[::1]/", "http://[2606:4700:4700::1111]/"]) {
      expect(validateLlmBaseUrl(u).ok).toBe(true);
      expect(validateWebhookUrl(u).ok).toBe(true);
    }
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

  test("curated loopback URLs are REJECTED when allowLocalExemption=false", () => {
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

// ─── DNS-resolution SSRF guard (closes the rebinding-to-metadata hole) ───
//
// `validateLlmBaseUrl` / `isAllowedLlmBaseUrl` inspect ONLY the parsed HOST, so
// a public hostname that DNS-resolves to an internal/metadata IP is not caught
// by the synchronous path. `resolveAndValidateLlmBaseUrl` resolves the hostname
// (when a resolver is available) and rejects any resolution into the blocked
// ranges. These tests pin that behavior so a future refactor that drops the DNS
// step — or weakens the fail-closed `error`/`unavailable` paths — is caught.

// Mock `chrome.dns.resolve` so the resolution is fully controlled (no real
// network). The host argument is ignored; `cb` receives the canned IPs. The
// `error` mode simulates `chrome.runtime.lastError` to exercise the
// fail-closed path. With both `chrome` and `require` absent (the test runtime's
// default), `dnsResolve` returns `unavailable`, which we use directly for the
// unavailable-resolution cases.
type DnsMode =
  | { kind: "resolved"; addresses: string[] }
  | { kind: "error" };

function setMockDns(mode: DnsMode): void {
  const chrome = globalThis as unknown as {
    chrome?: { runtime?: { lastError?: { message: string } }; dns?: { resolve?: (h: string, cb: (r: { addresses?: string[] }) => void) => void } };
  };
  if (mode.kind === "error") {
    chrome.chrome = {
      runtime: {},
      dns: { resolve: (_h: string, _cb: (r: { addresses?: string[] }) => void) => { throw new Error("dns failure"); } },
    };
    return;
  }
  chrome.chrome = {
    runtime: {},
    dns: { resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) => cb({ addresses: mode.addresses }) },
  };
}

function clearMockDns(): void {
  (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
}

describe("resolveAndValidateLlmBaseUrl (DNS-resolution SSRF guard)", () => {
  afterEach(() => {
    clearMockDns();
  });

  test("rejects a hostname that DNS-resolves to the cloud-metadata address", async () => {
    setMockDns({ kind: "resolved", addresses: ["169.254.169.254"] });
    const res = await resolveAndValidateLlmBaseUrl("http://metadata.example.attacker/v1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.reason).toMatch(/private\/loopback\/link-local/i);
  });

  test("hostname → loopback: rejected when allowLocalExemption=false, allowed when true", async () => {
    setMockDns({ kind: "resolved", addresses: ["127.0.0.1"] });
    const rejected = await resolveAndValidateLlmBaseUrl("http://ollama.example.attacker/v1", false);
    expect(rejected.ok).toBe(false);
    const allowed = await resolveAndValidateLlmBaseUrl("http://ollama.example.attacker/v1", true);
    expect(allowed.ok).toBe(true);
  });

  test("error resolver: fail-closed for untrusted AND user-configured (unverifiable target)", async () => {
    setMockDns({ kind: "error" });
    const rejected = await resolveAndValidateLlmBaseUrl("http://example.attacker/v1", false);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.reason).toMatch(/DNS resolution/i);
    // A resolver error FAILS CLOSED regardless of provenance — a user-configured
    // origin whose target IP cannot be verified must not be trusted either.
    const alsoRejected = await resolveAndValidateLlmBaseUrl("http://example.attacker/v1", true);
    expect(alsoRejected.ok).toBe(false);
    if (alsoRejected.ok) throw new Error("expected rejection");
    expect(alsoRejected.reason).toMatch(/DNS resolution/i);
  });

  test("unavailable resolver: fail-closed for untrusted AND user-configured", async () => {
    clearMockDns(); // no chrome.dns, no require → resolveAndValidateLlmBaseUrl sees `unavailable`
    const rejected = await resolveAndValidateLlmBaseUrl("http://example.attacker/v1", false);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.reason).toMatch(/DNS (resolution|resolver unavailable)/i);
    // No resolver available FAILS CLOSED regardless of provenance — when the
    // real target IP cannot be verified we must never trust the URL.
    const alsoRejected = await resolveAndValidateLlmBaseUrl("http://example.attacker/v1", true);
    expect(alsoRejected.ok).toBe(false);
    if (alsoRejected.ok) throw new Error("expected rejection");
    expect(alsoRejected.reason).toMatch(/DNS (resolution|resolver unavailable)/i);
  });

  test("still rejects a genuine IP-literal sink (no DNS needed)", async () => {
    clearMockDns();
    const res = await resolveAndValidateLlmBaseUrl("http://169.254.169.254/");
    expect(res.ok).toBe(false);
  });

  test("rejects a hostname that DNS-resolves to an IPv6 link-local address", async () => {
    setMockDns({ kind: "resolved", addresses: ["fe80::1"] });
    const res = await resolveAndValidateLlmBaseUrl("http://meta6.example.attacker/v1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.reason).toMatch(/private\/loopback\/link-local/i);
  });

  test("rejects a hostname that DNS-resolves to an IPv4-mapped IPv6 metadata address", async () => {
    setMockDns({ kind: "resolved", addresses: ["::ffff:169.254.169.254"] });
    const res = await resolveAndValidateLlmBaseUrl("http://meta6.example.attacker/v1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.reason).toMatch(/private\/loopback\/link-local/i);
  });

  test("rejects when the resolver returns a mix of safe + blocked addresses (fail-closed)", async () => {
    setMockDns({ kind: "resolved", addresses: ["1.2.3.4", "169.254.169.254"] });
    const res = await resolveAndValidateLlmBaseUrl("http://mixed.example.attacker/v1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.reason).toMatch(/private\/loopback\/link-local/i);
  });

  test("a 'resolved' outcome with NO addresses fails closed (empty result must not be ok)", async () => {
    setMockDns({ kind: "resolved", addresses: [] });
    const res = await resolveAndValidateLlmBaseUrl("http://empty.example.attacker/v1");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.reason).toMatch(/no addresses|DNS/i);
  });
});

// ─── URL redaction (used in SSRF error messages and logs) ────────────────────

describe("redactUrl (URL redaction)", () => {
  test("strips simple userinfo (user:pass@)", () => {
    expect(redactUrl("http://user:pass@host/x")).toBe("http://host/x");
  });

  test("strips to the LAST '@' before the first '/' (multi-@ userinfo does not leak)", () => {
    // The old /\/\/[^/@]*@/ regex stopped at the FIRST '@', leaking
    // `name:Pass@host/x` out of `http://user@name:Pass@host/x`.
    expect(redactUrl("http://user@name:Pass@host/x")).toBe("http://host/x");
  });

  test("a legitimate '@' inside the path is preserved", () => {
    expect(redactUrl("https://host/@user/repo")).toBe("https://host/@user/repo");
  });

  test("userinfo with an '@' inside the password is fully stripped", () => {
    expect(redactUrl("http://user:pa@ss@host/x")).toBe("http://host/x");
  });

  test("stripQuery=false replaces the query with [redacted-query]", () => {
    expect(redactUrl("http://user:pass@host/x?token=1#frag", false)).toBe(
      "http://host/x[redacted-query]",
    );
  });
});

describe("SSRF provenance gate", () => {
  test("an untrusted-origin loopback URL is rejected even for a curated local provider", () => {
    // `http://localhost:11434` is Ollama's default — user-configured it is fine,
    // but if it arrived via an untrusted vector (injection / settings-sync /
    // crafted tool call) the curated-local exemption MUST NOT apply.
    expect(isAllowedLlmBaseUrl("http://localhost:11434", undefined, "untrusted")).toBe(false);
    expect(validateLlmBaseUrl("http://localhost:11434", undefined, "untrusted").ok).toBe(false);
    expect(
      validateLlmBaseUrl("http://127.0.0.1:4000", undefined, "untrusted").ok,
    ).toBe(false);
  });

  test("user-configured / absent provenance still allows a curated local provider", () => {
    expect(isAllowedLlmBaseUrl("http://localhost:11434", undefined, "user-configured")).toBe(true);
    // absent provenance → historical default (allowLocalExemption=true) preserves behavior
    expect(isAllowedLlmBaseUrl("http://localhost:11434")).toBe(true);
  });
});
