/**
 * Screenshot policy — `resolveScreenshotPolicy()` is the single source of
 * truth for capture + annotation:
 * - `quality` = `getScreenshotQuality()` (0-100, the CDP JPEG quality; the
 *   annotator divides by 100 at the call site because `canvasToDataUrl` takes
 *   0-1).
 * - `annotateMaxDimension` = `getScreenshotMaxDimension() || 1800` — an unset
 *   max dimension (0 = "keep full viewport") falls back to the annotator's
 *   historical 1800px cap so annotation-time capping stays ON by default.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

// ─── Mock chrome global ──────────────────────────────────────────────────────

const store: Record<string, unknown> = {};
let changeListener: ((changes: Record<string, unknown>, area: string) => void) | undefined;

(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: vi.fn(async (key: unknown) => {
        if (typeof key === "string") return { [key]: store[key] };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = store[k];
          return out;
        }
        return { ...store };
      }),
    },
    onChanged: {
      addListener: vi.fn((cb: (changes: Record<string, unknown>, area: string) => void) => {
        changeListener = cb;
      }),
      removeListener: vi.fn(),
    },
  },
};

// The tab-manager-utils getters cache their values and only refresh when the
// storage.onChanged listener fires with one of the screenshot keys. Fire it
// with all four keys so the cache is invalidated regardless of which key a
// test mutated.
function invalidateScreenshotCache(): void {
  changeListener?.(
    {
      screenshotQuality: { newValue: store.screenshotQuality },
      screenshotImageTokens: { newValue: store.screenshotImageTokens },
      screenshotMaxDimension: { newValue: store.screenshotMaxDimension },
      screenshotMaxBytes: { newValue: store.screenshotMaxBytes },
    },
    "local",
  );
}

let resolvePolicy: typeof import("../src/extension/background/screenshot-policy")["resolveScreenshotPolicy"];

beforeEach(async () => {
  vi.resetModules();
  changeListener = undefined;
  for (const k of Object.keys(store)) delete store[k];
  const mod = await import("../src/extension/background/screenshot-policy");
  resolvePolicy = mod.resolveScreenshotPolicy;
});

describe("resolveScreenshotPolicy", () => {
  test("default policy: quality 80, annotateMaxDimension 1800 (max dimension unset)", async () => {
    expect(await resolvePolicy()).toEqual({ quality: 80, annotateMaxDimension: 1800 });
  });

  test("screenshotMaxDimension=900 via storage → annotateMaxDimension 900", async () => {
    store.screenshotMaxDimension = 900;
    invalidateScreenshotCache();
    expect(await resolvePolicy()).toEqual({ quality: 80, annotateMaxDimension: 900 });
  });

  test("quality follows the stored screenshotQuality (0-100)", async () => {
    store.screenshotQuality = 60;
    invalidateScreenshotCache();
    expect(await resolvePolicy()).toEqual({ quality: 60, annotateMaxDimension: 1800 });
  });
});