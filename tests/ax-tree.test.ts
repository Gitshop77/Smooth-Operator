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

import { describe, test, expect, beforeEach, afterEach } from "vitest";
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
