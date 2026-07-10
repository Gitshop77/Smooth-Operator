/**
 * AX-tree extraction tests — verifies the real `ax-tree.ts` module exports.
 *
 * The full DOM-walking path requires a browser (or JSDOM), so these tests
 * cover the exported API surface that can be exercised in Node:
 *   - `generateAccessibilityTree` (signature + error path)
 *   - `initElementMap` (idempotent)
 *   - `resolveRef` (returns null when no map / dead ref)
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  generateAccessibilityTree,
  initElementMap,
  resolveRef,
} from "../src/lib/agent/dom/ax-tree";

// Lightweight stub for the global state the module reads from. Bun's test
// runner does not provide a DOM, so we stub the bare minimum the module
// touches at module-evaluation time and inside the public functions.
type WindowStub = {
  __openCoworkElementMap?: Record<string, { deref: () => unknown }>;
  __openCoworkElementReverseMap?: WeakMap<object, string>;
  __openCoworkRefCounter?: number;
  innerWidth: number;
  innerHeight: number;
};

declare global {
  var __axTestWindow: WindowStub | undefined;
}

function installWindowStub(): WindowStub {
  const stub: WindowStub = { innerWidth: 1024, innerHeight: 768 };
  // The module reads from the global `window` symbol — assign it.
  (globalThis as unknown as { window: WindowStub }).window = stub;
  return stub;
}

function clearWindowStub(): void {
  delete (globalThis as unknown as { window?: WindowStub }).window;
}

describe("ax-tree module exports", () => {
  test("exports the expected public API", () => {
    expect(typeof generateAccessibilityTree).toBe("function");
    expect(typeof initElementMap).toBe("function");
    expect(typeof resolveRef).toBe("function");
  });

  test("generateAccessibilityTree is callable (throws cleanly without a DOM)", () => {
    // Ensure no window so the module's first `window` reference throws.
    // The unwrapped ReferenceError ("window is not defined") escapes from
    // `initElementMap()` which runs before the try/catch wrapper, OR the
    // wrapped "Error generating accessibility tree: ..." form is thrown.
    // Either is acceptable — what matters is that calling it doesn't crash
    // the test runner silently.
    clearWindowStub();
    expect(() => generateAccessibilityTree()).toThrow();
  });
});

describe("initElementMap", () => {
  beforeEach(() => {
    installWindowStub();
  });

  afterEach(() => {
    clearWindowStub();
  });

  test("creates the element map / reverse map / counter on first call", () => {
    const w = (globalThis as unknown as { window: WindowStub }).window;
    delete w.__openCoworkElementMap;
    delete w.__openCoworkElementReverseMap;
    delete w.__openCoworkRefCounter;

    initElementMap();
    expect(w.__openCoworkElementMap).toEqual({});
    expect(w.__openCoworkElementReverseMap).toBeInstanceOf(WeakMap);
    expect(w.__openCoworkRefCounter).toBe(0);
  });

  test("is idempotent — a second call preserves existing state", () => {
    const w = (globalThis as unknown as { window: WindowStub }).window;
    initElementMap();
    const map = w.__openCoworkElementMap;
    const counter = w.__openCoworkRefCounter;
    // Simulate prior state.
    w.__openCoworkRefCounter = 7;
    initElementMap();
    // Map object identity preserved.
    expect(w.__openCoworkElementMap).toBe(map);
    // Counter not reset.
    expect(w.__openCoworkRefCounter).toBe(7);
    expect(counter).toBe(0);
  });
});

describe("resolveRef", () => {
  beforeEach(() => {
    installWindowStub();
  });

  afterEach(() => {
    clearWindowStub();
  });

  test("returns null when the element map has not been initialized", () => {
    const w = (globalThis as unknown as { window: WindowStub }).window;
    delete w.__openCoworkElementMap;
    expect(resolveRef("ref_1")).toBeNull();
  });

  test("returns null for an unknown ref id", () => {
    initElementMap();
    expect(resolveRef("ref_does_not_exist")).toBeNull();
  });

  test("returns the dereferenced element when the ref is live", () => {
    initElementMap();
    const w = (globalThis as unknown as { window: WindowStub }).window;
    const fakeEl = { tag: "button" };
    w.__openCoworkElementMap!["ref_1"] = { deref: () => fakeEl };
    expect(resolveRef("ref_1")).toBe(fakeEl);
  });

  test("cleans up dead refs (dereferenced to undefined) and returns null", () => {
    initElementMap();
    const w = (globalThis as unknown as { window: WindowStub }).window;
    w.__openCoworkElementMap!["ref_dead"] = { deref: () => undefined };
    expect(resolveRef("ref_dead")).toBeNull();
    // The dead ref should have been removed from the map.
    expect(w.__openCoworkElementMap!["ref_dead"]).toBeUndefined();
  });
});

describe("generateAccessibilityTree", () => {
  beforeEach(() => {
    installWindowStub();
  });

  afterEach(() => {
    clearWindowStub();
  });

  test("returns an error result for an unknown refId (after init)", () => {
    initElementMap();
    const result = generateAccessibilityTree("all", 15, undefined, "ref_missing");
    expect(result.error).toContain("ref_id 'ref_missing'");
    expect(result.pageContent).toBe("");
    expect(result.viewport).toEqual({ width: 1024, height: 768 });
  });

  test("returns an error result for a dead ref (deref returns undefined)", () => {
    initElementMap();
    const w = (globalThis as unknown as { window: WindowStub }).window;
    w.__openCoworkElementMap!["ref_dead"] = { deref: () => undefined };
    const result = generateAccessibilityTree("all", 15, undefined, "ref_dead");
    expect(result.error).toContain("no longer exists");
    expect(result.pageContent).toBe("");
  });

  test("honors a generous maxLength cap (content fits) — no error returned", () => {
    // Inject a fake document.body with no children. The tree builder will
    // emit zero lines, so pageContent is empty — well under any positive
    // cap. We verify the cap path is reachable in principle and that no
    // error is thrown when content fits.
    (globalThis as unknown as { document: unknown }).document = {
      body: {
        tagName: "BODY",
        children: [],
        childNodes: [],
        getAttribute: () => null,
        getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
        offsetWidth: 0,
        offsetHeight: 0,
      },
    };
    try {
      const result = generateAccessibilityTree("all", 15, 1000);
      expect(result.error).toBeUndefined();
      expect(typeof result.pageContent).toBe("string");
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  });
});
