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
import { redactUrlTokens } from "../src/lib/agent/dom/extraction/element-info";
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
});
