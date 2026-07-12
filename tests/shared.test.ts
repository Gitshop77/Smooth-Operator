/**
 * Tests for shared.ts — escapeHtml (`/`) + getCockpitUrl scheme validation.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { escapeHtml, getCockpitUrl, DEFAULT_COCKPIT_URL, COCKPIT_URL_STORAGE_KEY } from "../src/extension/shared";

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

  test("falls back to default for an empty/invalid stored value", async () => {
    store[COCKPIT_URL_STORAGE_KEY] = "   ";
    expect(await getCockpitUrl()).toBe(DEFAULT_COCKPIT_URL);
  });
});
