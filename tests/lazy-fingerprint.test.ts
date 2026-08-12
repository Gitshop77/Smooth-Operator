/**
 * Lazy `beforeFingerprint` — the executor must not pay the
 * O(interactive-elements) DOM fingerprint scan for actions that never check
 * page change. `makeLazyFingerprint` defers `domFingerprint()` to the first
 * read and memoizes it; `hasPageChanged` resolves either the lazy holder or a
 * legacy plain-string fingerprint.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  makeLazyFingerprint,
  hasPageChanged,
  resolveBeforeFingerprint,
  type ActionContext,
} from "../src/lib/agent/tools/handlers/types";
import type { BrowserState } from "../src/lib/agent/types";

function makeCtx(fp: string | ReturnType<typeof makeLazyFingerprint>): ActionContext {
  return {
    state: {} as BrowserState,
    beforeUrl: location.href,
    beforeFingerprint: fp as unknown as string,
  };
}

describe("makeLazyFingerprint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../src/lib/agent/tools/helpers", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/agent/tools/helpers")>(
        "../src/lib/agent/tools/helpers",
      );
      return {
        ...actual,
        domFingerprint: vi.fn(() => "fp-value"),
      };
    });
  });

  test("defers the fingerprint computation until first read and memoizes it", async () => {
    const { domFingerprint } = await import("../src/lib/agent/tools/helpers");
    const { makeLazyFingerprint: lazyFactory } = await import(
      "../src/lib/agent/tools/handlers/types"
    );
    const fp = lazyFactory();
    // No computation until the first read.
    expect(domFingerprint).not.toHaveBeenCalled();
    expect(fp.get()).toBe("fp-value");
    expect(domFingerprint).toHaveBeenCalledTimes(1);
    // Memoized — the second read must not re-scan the DOM.
    expect(fp.get()).toBe("fp-value");
    expect(domFingerprint).toHaveBeenCalledTimes(1);
  });
});

describe("hasPageChanged / resolveBeforeFingerprint", () => {
  test("resolves a legacy plain-string fingerprint unchanged", () => {
    const ctx = makeCtx("legacy-fp");
    expect(resolveBeforeFingerprint(ctx)).toBe("legacy-fp");
  });

  test("resolves a lazy holder once (no DOM scan at context build)", () => {
    const holder = makeLazyFingerprint();
    const ctx = makeCtx(holder);
    expect(holder.get()).toBeTypeOf("string");
    expect(resolveBeforeFingerprint(ctx)).toBe(holder.get());
  });

  test("reports no page change when URL and fingerprint are stable", () => {
    const ctx = makeCtx(makeLazyFingerprint());
    // Same document, no mutation → the lazy baseline equals the current scan.
    expect(hasPageChanged(ctx)).toBe(false);
  });

  test("reports a page change when the URL differs from the baseline", () => {
    const ctx = makeCtx(makeLazyFingerprint());
    const url = new URL(location.href);
    url.searchParams.set("changed", "1");
    history.replaceState(null, "", url.toString());
    try {
      expect(hasPageChanged(ctx)).toBe(true);
    } finally {
      history.replaceState(null, "", new URL(location.href).pathname);
    }
  });
});
