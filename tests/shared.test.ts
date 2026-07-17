/**
 * Tests for shared.ts — escapeHtml (`/`) + getCockpitUrl scheme validation.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { $, escapeHtml, getCockpitUrl, DEFAULT_COCKPIT_URL, COCKPIT_URL_STORAGE_KEY, redactKeyLeak } from "../src/extension/shared";

describe("$", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("returns the element when present", () => {
    document.body.innerHTML = `<div id="present"></div>`;
    expect($("present").id).toBe("present");
  });

  test("throws when the element is missing", () => {
    expect(() => $("missing-id")).toThrow(/missing #missing-id/);
  });
});

describe("escapeHtml", () => {
  test("escapes the core XML characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;&#47;a&gt;");
  });

  test("also escapes '/' to &#47;", () => {
    expect(escapeHtml("a/b")).toBe("a&#47;b");
 // Harmless in normal text rendering, but closes the cross-context hole.
    expect(escapeHtml("anthropic/claude-3-5-sonnet")).toBe("anthropic&#47;claude-3-5-sonnet");
  });

  test("non-special characters are passed through unchanged", () => {
    expect(escapeHtml("Hello, world! 123")).toBe("Hello, world! 123");
  });

  test("returns '' for null / undefined input", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

// ─── redactKeyLeak secret masking ─────────────────────────────────────

describe("redactKeyLeak", () => {
  test("masks each base key-pattern family", () => {
    const cases: Array<[string, string]> = [
      ["sk-ant-api03-ABCDEFGHIJKLMNOP", "sk-[REDACTED]"],
      ["sk-proj-abcdefghijklmnop", "sk-[REDACTED]"],
      ["AIzaSyABCDEFGHIJKLMNOP", "AIza[REDACTED]"],
      ["ya29.abcdefghijklmnop", "ya29[REDACTED]"],
      ["ghp_abcdefghijklmnop", "ghp_[REDACTED]"],
      ["gho_abcdefghijklmnop", "gho_[REDACTED]"],
      ["ghu_abcdefghijklmnop", "ghu_[REDACTED]"],
      ["ghs_abcdefghijklmnop", "ghs_[REDACTED]"],
      ["ghr_abcdefghijklmnop", "ghr_[REDACTED]"],
      ["github_pat_abcdefghijklmnop", "gith[REDACTED]"],
      ["glpat-abcdefghijklmnop", "glpat-[REDACTED]"],
      ["gsk_abcdefghijklmnop", "gsk_[REDACTED]"],
      ["xoxb-abcdefghijklmnop", "xoxb-[REDACTED]"],
      ["xoxp-abcdefghijklmnop", "xoxp-[REDACTED]"],
      ["xoxa-abcdefghijklmnop", "xoxa-[REDACTED]"],
      ["xoxs-abcdefghijklmnop", "xoxs-[REDACTED]"],
      ["AKIA1234567890ABCDEF", "AKIA[REDACTED]"],
      ["eyJhbGciOi.eyJzdWIi.SflKxw", "eyJh[REDACTED]"],
    ];
    for (const [input, expected] of cases) {
      expect(redactKeyLeak(input)).toBe(expected);
    }
  });

  test("masks a key derived from the PROVIDER_META catalog", () => {
    // `xai-...` is a provider-derived prefix (not in BASE_KEY_PATTERNS).
    expect(redactKeyLeak("xai-abcdefghijklmnop")).toBe("xai-[REDACTED]");
  });

  test("redacts a key embedded in surrounding error text", () => {
    const input = "401: Invalid API key: sk-ant-api03-secretkey123";
    expect(redactKeyLeak(input)).toBe("401: Invalid API key: sk-[REDACTED]");
  });

  test("passes non-key text through unchanged", () => {
    const input = "Hello, this is a normal message with no secrets.";
    expect(redactKeyLeak(input)).toBe(input);
  });

  test("masks the value of a known JSON secret key with no key prefix", () => {
    expect(redactKeyLeak('{"password":"Tr0ub4dor&3"}')).toBe('{"password":"[REDACTED]"}');
  });

  test("masks a generic high-entropy quoted scalar with no key prefix", () => {
    expect(redactKeyLeak('"aB3$xY9qLm2!zK7wRt5vNh8uCp4"')).toBe('"[REDACTED]"');
  });
});

// ─── getCockpitUrl scheme validation ──────────────────────────────────

describe("getCockpitUrl", () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: (keys: string | string[]) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const result: Record<string, unknown> = {};
            for (const k of keyArr) if (k in store) result[k] = store[k];
            return Promise.resolve(result);
          },
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  test("returns the default URL when nothing is stored", async () => {
    expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
  });

  test("returns a stored http:// URL", async () => {
    store[COCKPIT_URL_STORAGE_KEY] = "http://cockpit.local:8080";
    expect(await getCockpitUrl()).toBe("http://cockpit.local:8080");
  });

  test("returns a stored https:// URL", async () => {
    store[COCKPIT_URL_STORAGE_KEY] = "https://cockpit.example.com/";
    expect(await getCockpitUrl()).toBe("https://cockpit.example.com/");
  });

  test("falls back to default for a javascript: URL", async () => {
    store[COCKPIT_URL_STORAGE_KEY] = "javascript:alert(1)";
    expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
  });

  test("falls back to default for a data: URL", async () => {
    store[COCKPIT_URL_STORAGE_KEY] = "data:text/html,<script>alert(1)</script>";
    expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
  });

  test.each(["blob:foo", "file:///etc/passwd", "ftp://evil.com", "about:blank"])(
    "falls back to default for a %s URL (non-http(s) scheme floor)",
    async (u) => {
      store[COCKPIT_URL_STORAGE_KEY] = u;
      expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
    },
  );

  test("falls back to default for an empty/invalid stored value", async () => {
    store[COCKPIT_URL_STORAGE_KEY] = "   ";
    expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
  });

  test("falls back to default when storage get rejects", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: () => Promise.reject(new Error("storage unavailable")),
        },
      },
    };
    expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
  });
});
