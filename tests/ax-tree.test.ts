/**
 * AX-tree extraction tests — verifies the real `ax-tree.ts` module exports.
 *
 * The full DOM-walking path requires a browser (or JSDOM), so these tests
 * cover the exported API surface that can be exercised in Node:
 * - `generateAccessibilityTree` (signature + error path)
 * - `initElementMap` (idempotent; creates the off-window registry)
 * - `resolveRef` (returns null for unknown/unregistered refs, the element
 * for a live registered ref)
 *
 * The element-ref registry is intentionally module-scoped (off `window`) for
 * security, so these tests use the `__test_*` accessors (the same mechanism
 * the real `buildTree` uses to register elements) rather than poking at a
 * `window.__openCowork*` global that no longer exists.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateAccessibilityTree,
  initElementMap,
  resolveRef,
  __test_registry,
  __test_registerElement,
  __test_resetRegistry,
} from "../src/lib/agent/dom/ax-tree";

// Lightweight stub for the global `window` the module reads from (viewport).
// The registry itself lives in module scope, NOT on this stub.
type WindowStub = {
  innerWidth: number;
  innerHeight: number;
};

function installWindowStub(): WindowStub {
  const stub: WindowStub = { innerWidth: 1024, innerHeight: 768 };
  (globalThis as unknown as { window: WindowStub }).window = stub;
  return stub;
}

function clearWindowStub(): void {
  delete (globalThis as unknown as { window?: WindowStub }).window;
}

// Factory for the minimal fake element used throughout these tests.
const makeFakeButton = (): HTMLElement =>
  ({ tagName: "BUTTON" } as unknown as HTMLElement);

// Factory for a minimal fake `document` whose `body` satisfies the shape
// `generateAccessibilityTree` reads (tagName/children/getBoundingClientRect/…).
const makeFakeDocument = (): { document: unknown } => ({
  document: {
    body: {
      tagName: "BODY",
      children: [],
      childNodes: [],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      offsetWidth: 0,
      offsetHeight: 0,
    },
  },
});

// Register the window-stub before/after hooks on the enclosing describe block.
function withWindowStub(): void {
  beforeEach(() => {
    installWindowStub();
  });
  afterEach(() => {
    clearWindowStub();
  });
}

// Keep the module-scoped registry deterministic across tests (it persists for
// the lifetime of the module, and initElementMap alone is idempotent).
beforeEach(() => {
  __test_resetRegistry();
});

describe("ax-tree module exports", () => {
  test("exports the expected public API", () => {
    expect(typeof generateAccessibilityTree).toBe("function");
    expect(typeof initElementMap).toBe("function");
    expect(typeof resolveRef).toBe("function");
  });

  test("initElementMap + resolveRef behave correctly (behavioral)", () => {
    // Before any registration, an unknown ref resolves to null.
    initElementMap();
    expect(__test_registry().initialized).toBe(true);
    expect(__test_registry().size).toBe(0);
    expect(resolveRef("ref_never_registered")).toBeNull();

    // Register a real element (mirrors how buildTree registers during a real
    // DOM walk) and confirm resolveRef returns it.
    const fakeEl = makeFakeButton();
    __test_registerElement("ref_1", fakeEl);
    expect(resolveRef("ref_1")).toBe(fakeEl);

    // Unknown refs still resolve to null even after registration.
    expect(resolveRef("ref_does_not_exist")).toBeNull();
  });

  test("generateAccessibilityTree is callable (throws cleanly without a DOM)", () => {
    clearWindowStub();
    expect(() => generateAccessibilityTree()).toThrow(/document|window/i);
  });
});

describe("initElementMap", () => {
  withWindowStub();

  test("initializes the off-window registry on first call", () => {
    initElementMap();
    const reg = __test_registry();
    expect(reg.initialized).toBe(true);
    expect(reg.size).toBe(0);
    expect(reg.counter).toBe(0);
  });

  test("is idempotent — a second call preserves existing state", () => {
    initElementMap();
    const fakeEl = makeFakeButton();
    __test_registerElement("ref_1", fakeEl);
    expect(resolveRef("ref_1")).toBe(fakeEl);

    // Second init must NOT wipe the registry (idempotent, not a reset).
    initElementMap();
    expect(resolveRef("ref_1")).toBe(fakeEl);
    expect(__test_registry().size).toBeGreaterThan(0);
  });
});

describe("resolveRef", () => {
  withWindowStub();

  test("returns null for an unknown / unregistered ref id", () => {
    initElementMap();
    expect(resolveRef("ref_does_not_exist")).toBeNull();
  });

  test("returns the registered element when the ref is live", () => {
    initElementMap();
    const fakeEl = makeFakeButton();
    __test_registerElement("ref_1", fakeEl);
    expect(resolveRef("ref_1")).toBe(fakeEl);
  });
});

describe("AX WeakRef registry pruning throttle", () => {
  withWindowStub();

  // Prune thresholds in ax-tree-builder.ts (module-private consts):
  // AX_REGISTRY_PRUNE_INTERVAL = 25 calls, AX_REGISTRY_PRUNE_BOUND = 5_000.
  // jsdom has no real GC, so WeakRef targets never get reclaimed — these
  // tests assert the prune *decision* (a spy on Object.keys, which the prune
  // scan is the only module code to call) and the identity fallback
  // (removed-but-live refs still resolve), never that a ref was reclaimed.
  //
  // The fake document keeps jsdom internals out of the walk so the spy sees
  // ONLY the AX module's own Object.keys calls.
  function runGeneration(): void {
    (globalThis as unknown as { document: unknown }).document = makeFakeDocument().document;
    try {
      generateAccessibilityTree("all", 15, 1000);
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  }

  test("freshly-registered refs still resolve", () => {
    initElementMap();
    const fakeEl = makeFakeButton();
    __test_registerElement("ref_1", fakeEl);
    expect(resolveRef("ref_1")).toBe(fakeEl);
  });

  test("registry prune does NOT run on every generation (Object.keys spy)", () => {
    initElementMap();
    __test_registerElement("ref_1", makeFakeButton());
    expect(resolveRef("ref_1")).not.toBeNull();
    const keysSpy = vi.spyOn(Object, "keys");
    try {
      const before = keysSpy.mock.calls.length;
      // 5 generations — well under the 25-call prune interval, and the
      // registry stays far below the 5_000-entry bound, so the full-map
      // prune scan must not run at all.
      for (let i = 0; i < 5; i++) runGeneration();
      expect(keysSpy.mock.calls.length - before).toBe(0);
    } finally {
      keysSpy.mockRestore();
    }
  });

  test("registry prune DOES run once the 25-call interval is reached", () => {
    initElementMap();
    const keysSpy = vi.spyOn(Object, "keys");
    try {
      const before = keysSpy.mock.calls.length;
      // 25 generations — the 25th call crosses AX_REGISTRY_PRUNE_INTERVAL,
      // so exactly one full-map scan must happen (not zero, not 25).
      for (let i = 0; i < 25; i++) runGeneration();
      expect(keysSpy.mock.calls.length - before).toBe(1);
    } finally {
      keysSpy.mockRestore();
    }
  });

  test("registry prune runs early when the 5_000-entry bound is exceeded", () => {
    initElementMap();
    const first = makeFakeButton();
    __test_registerElement("ref_bound_0", first);
    for (let i = 1; i <= 5_000; i++) {
      __test_registerElement(`ref_bound_${i}`, makeFakeButton());
    }
    const keysSpy = vi.spyOn(Object, "keys");
    try {
      const before = keysSpy.mock.calls.length;
      // One generation — far below the interval, but the registry already
      // exceeds AX_REGISTRY_PRUNE_BOUND, so the bound gate must fire.
      runGeneration();
      expect(keysSpy.mock.calls.length - before).toBe(1);
    } finally {
      keysSpy.mockRestore();
    }
    // No real GC in jsdom: every entry is still live, so the scan prunes
    // nothing and every ref still resolves by identity.
    expect(__test_registry().size).toBe(5_001);
    expect(resolveRef("ref_bound_0")).toBe(first);
  });
});

describe("generateAccessibilityTree", () => {
  withWindowStub();

  test("returns an error result for an unknown refId (after init)", () => {
    initElementMap();
    const result = generateAccessibilityTree("all", 15, undefined, "ref_missing");
    expect(result.error).toContain("ref_id 'ref_missing'");
    expect(result.pageContent).toBe("");
    expect(result.viewport).toEqual({ width: 1024, height: 768 });
  });

  test("rejects an invalid filter value with a clear TypeError", () => {
    expect(() => generateAccessibilityTree("bogus", 15)).toThrow(TypeError);
  });

  test("honors a generous maxLength cap (content fits) — no error returned", () => {
    (globalThis as unknown as { document: unknown }).document = makeFakeDocument().document;
    try {
      const result = generateAccessibilityTree("all", 15, 1000);
      expect(result.error).toBeUndefined();
      expect(typeof result.pageContent).toBe("string");
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  });
});
