/**
 * Regression test for page-URL token redaction.
 *
 * Locks the invariant that the page URL surfaced to the LLM / run-history is
 * stripped of query/fragment tokens (session ids, 2FA/OTP codes, OAuth
 * `code`/`access_token`, PII). A future refactor that dropped the redaction
 * on `BrowserState.url` would leak those tokens to the model and into
 * unencrypted run-history; this test fails loudly if that regresses.
 */
import { describe, it, expect, afterEach } from "vitest";
import { redactUrlTokens } from "../src/lib/agent/dom/extraction/element-info-utils";
import { extractBrowserState } from "../src/lib/agent/dom/extraction/page-state";

describe("redactUrlTokens (page-URL token redaction)", () => {
  it("strips query and fragment tokens from an http(s) URL", () => {
    const redacted = redactUrlTokens(
      "https://bank.com/confirm?token=abc123&code=def#access_token=xyz",
    );
    expect(redacted).toBe("https://bank.com/confirm");
    expect(redacted).not.toContain("?");
    expect(redacted).not.toContain("#");
    expect(redacted).not.toContain("token");
    expect(redacted).not.toContain("access_token");
  });

  it("strips userinfo (username:password@) from the authority", () => {
    const redacted = redactUrlTokens("https://user:s3cr3t@bank.com/confirm");
    expect(redacted).toBe("https://bank.com/confirm");
    expect(redacted).not.toContain("user");
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("@");
  });

  it("masks high-entropy secret path segments but keeps the route", () => {
    const redacted = redactUrlTokens(
      "https://bank.com/reset/aB3xZ9qL7mN2pQ8r/done",
    );
    expect(redacted).toBe("https://bank.com/reset/[redacted]/done");
    expect(redacted).not.toContain("aB3xZ9qL7mN2pQ8r");
  });

  it("preserves ordinary human-readable path segments", () => {
    expect(redactUrlTokens("https://example.com/docs/getting-started")).toBe(
      "https://example.com/docs/getting-started",
    );
  });

  it("returns the placeholder for non-http(s) URLs", () => {
    expect(redactUrlTokens("about:blank")).toBe("[non-http url redacted]");
    expect(redactUrlTokens("file:///etc/passwd")).toBe(
      "[non-http url redacted]",
    );
  });

  it("redacts secret-looking hostname labels with a valid host marker", () => {
    // Assigning "[redacted]" to the hostname failed
    // silently (brackets are forbidden host code points), so the raw secret
    // label survived into the page representation.
    const redacted = redactUrlTokens(
      "https://mySecretToken1234567890.example.com/some/path",
    );
    expect(redacted).toBe("https://redacted.example.com/some/path");
    expect(redacted).not.toMatch(/mysecrettoken1234567890/i);
  });

  it("redacts a hyphenated hostname label when the URL carried userinfo", () => {
    // `secret-token` is lowercase + hyphen (2 character classes); the
    // secret-segment classifier only treats special-char segments as
    // secrets at 3+ classes, so it previously survived as a raw hostname
    // label once the userinfo was stripped.
    const redacted = redactUrlTokens(
      "https://user:pass@secret-token.example.com/panel",
    );
    expect(redacted).toBe("https://redacted.example.com/panel");
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("@");
  });

  it("preserves hyphenated hostname labels in URLs without userinfo", () => {
    expect(redactUrlTokens("https://secret-token.example.com/panel")).toBe(
      "https://secret-token.example.com/panel",
    );
  });

  it("redacts hyphenated hostname labels in protocol-relative userinfo URLs", () => {
    const redacted = redactUrlTokens(
      "//user:pass@secret-token.example.com/path",
    );
    expect(redacted).toBe("//redacted.example.com/path");
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("@");
  });

  it("redacts userinfo, hostname secret, query, and path secret in one URL", () => {
    const redacted = redactUrlTokens(
      "https://user:s3cr3t@mySecretToken1234567890.example.com/reset/aB3xZ9qL7mN2pQ8r/done?token=abc123#frag",
    );
    expect(redacted).toBe("https://redacted.example.com/reset/[redacted]/done");
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("@");
    expect(redacted).not.toMatch(/mysecrettoken1234567890/i);
    expect(redacted).not.toContain("aB3xZ9qL7mN2pQ8r");
    expect(redacted).not.toContain("abc123");
  });

  it("strips userinfo from unparseable protocol-relative URLs", () => {
    // new URL() throws without a base, so this goes down the fallback path,
    // which previously left `user:pass@` intact.
    const redacted = redactUrlTokens("//user:pass@example.com/path");
    expect(redacted).toBe("//example.com/path");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("@");
  });
});

describe("extractBrowserState.url redaction", () => {
  afterEach(() => {
    // Restore the real location so other tests are unaffected.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  const originalLocation = window.location;

  it("returns a scheme+host+path URL with no query/fragment tokens", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://bank.com/confirm?token=abc123&code=def#access_token=xyz",
      },
    });

    const state = extractBrowserState([]);
    expect(state.url).toBe("https://bank.com/confirm");
    expect(state.url).not.toContain("?");
    expect(state.url).not.toContain("#");
    expect(state.url).not.toContain("token");
    expect(state.url).not.toContain("access_token");
  });

  it("redacts hostname secrets and userinfo from BrowserState.url", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://user:s3cr3t@mySecretToken1234567890.example.com/path",
      },
    });

    const state = extractBrowserState([]);
    expect(state.url).toBe("https://redacted.example.com/path");
    expect(state.url).not.toContain("s3cr3t");
    expect(state.url).not.toMatch(/mysecrettoken1234567890/i);
  });
});

describe("extractBrowserState iframe src redaction", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("redacts userinfo and hostname secrets from iframe src lines", () => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute(
      "src",
      "https://user:s3cr3t@mySecretToken1234567890.example.com/panel",
    );
    // jsdom has no layout, so offsetParent is null and isLikelyHidden would
    // drop the iframe before the src is serialized; position:fixed routes
    // around that pre-check (fixed elements pass isLikelyHidden).
    iframe.style.position = "fixed";
    document.body.appendChild(iframe);

    const state = extractBrowserState([]);
    expect(state.elementsText).toContain("|IFRAME src=");
    expect(state.elementsText).toContain("redacted.example.com");
    expect(state.elementsText).not.toContain("s3cr3t");
    expect(state.elementsText).not.toContain("user:");
    expect(state.elementsText).not.toMatch(/mysecrettoken1234567890/i);
  });
});
