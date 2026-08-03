/**
 * AX-tree deep-chain regression tests — a DOM-API-built (or hostile-page)
 * chain of thousands of *excluded* elements (no text, no role) used to
 * bypass the emitted-depth guard: the old builder only advanced the depth
 * counter for *included* elements, so a chain of excluded `<div>`s recursed
 * unboundedly and blew the call stack (`RangeError`), failing `read_page` /
 * AX extraction instead of truncating.
 *
 * The builder now tracks an absolute recursion depth that ALWAYS increments,
 * independent of the emitted-depth counter, so excluded chains truncate at a
 * hard cap instead of overflowing the stack.
 *
 * Run with: `npx vitest run tests/ax-tree-deep-chain.test.ts`
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  generateAccessibilityTree,
  __test_resetRegistry,
} from "../src/lib/agent/dom/ax-tree";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";

beforeEach(() => {
  document.body.innerHTML = "";
  __test_resetRegistry();
  installJsdomLayoutMock();
});

afterEach(() => {
  restoreJsdomLayoutMock();
});

/**
 * Chain depth built per innerHTML chunk. jsdom's HTML parser attaches each
 * parsed element with the spec's ancestor walk, but per *chunk* (not per
 * node): a 1000-deep chunk costs one O(depth) attach instead of O(depth)
 * per appendChild, and the attach recursion (~1000 frames) stays well under
 * the stack limit (a single 5000-deep parse overflows it).
 */
const CHAIN_CHUNK = 1000;

/**
 * Append a chain of `count` nested `<div>`s (all excluded: no text, no role)
 * and return the deepest element.
 *
 * Built with `innerHTML` in 1000-deep chunks instead of one `appendChild`
 * per node: jsdom's `appendChild`/`remove` run the DOM spec's ancestor walk
 * per node, so a 5000-deep chain built one append at a time takes ~15s and
 * dominates the test runtime (and the quadratic walk makes the file flaky
 * against the 30s vitest timeout). The parser path is O(1) per node, so the
 * same 5000-deep tree takes ~2s.
 */
function appendDivChain(count: number): HTMLElement {
  let root: HTMLElement = document.body;
  let built = 0;
  while (built < count) {
    const n = Math.min(CHAIN_CHUNK, count - built);
    root.innerHTML = "<div>".repeat(n) + "</div>".repeat(n);
    for (let i = 0; i < n; i++) root = root.firstElementChild as HTMLElement;
    built += n;
  }
  return root;
}

/**
 * Remove a chain built by `appendDivChain`, detaching it in 1000-deep
 * subtrees (top-down). Removing one node at a time is quadratic in jsdom
 * (~13s for 5000 nodes) because each `remove()` walks the whole ancestor
 * chain; removing a bounded subtree is linear and stack-safe because
 * jsdom's recursive detach is bounded by the subtree depth.
 */
function disposeDivChain(leaf: HTMLElement): void {
  let node: HTMLElement | null = leaf;
  while (node && node !== document.body) {
    // Ascend to the top of the current chunk (the node whose subtree is
    // exactly CHAIN_CHUNK deep) and detach the whole subtree at once.
    let chunkTop: HTMLElement = node;
    let depth = 0;
    while (
      chunkTop.parentElement &&
      chunkTop.parentElement !== document.body &&
      depth < CHAIN_CHUNK - 1
    ) {
      chunkTop = chunkTop.parentElement;
      depth++;
    }
    // Explicit annotation: the loop back-edge (node = up) makes TS's flow
    // analysis of `node.parentElement` circular without it.
    const up: HTMLElement | null = chunkTop.parentElement;
    chunkTop.remove();
    node = up;
  }
}

describe("deep excluded-element chains", () => {
  test("a 5000-deep chain of excluded divs does not overflow the stack", () => {
    const leaf = appendDivChain(5000);
    try {
      // Must truncate gracefully instead of throwing RangeError.
      expect(() => generateAccessibilityTree("all")).not.toThrow();
      const result = generateAccessibilityTree("all");
      expect(result.error).toBeUndefined();
    } finally {
      disposeDivChain(leaf);
    }
  });

  test("a deep chain with a large requested depth still truncates safely", () => {
    const leaf = appendDivChain(5000);
    try {
      // depth=1000 is valid input; the absolute recursion cap (not maxDepth)
      // is what keeps this from overflowing.
      expect(() => generateAccessibilityTree("all", 1000)).not.toThrow();
    } finally {
      disposeDivChain(leaf);
    }
  });

  test("a deep chain of excluded divs does not emit runaway lines", () => {
    const leaf = appendDivChain(5000);
    try {
      const result = generateAccessibilityTree("all", 1000);
      const inner = (result.pageContent ?? "")
        .replace(/^<untrusted_page_state>\n?/, "")
        .replace(/\n?<\/untrusted_page_state>$/, "");
      expect(inner.split("\n").filter((l) => l.length > 0).length).toBeLessThan(600);
    } finally {
      disposeDivChain(leaf);
    }
  });

  test("normal included structures are unaffected by the absolute cap", () => {
    let root: HTMLElement = document.body;
    for (let i = 0; i < 8; i++) {
      const nav = document.createElement("nav");
      root.appendChild(nav);
      root = nav;
    }
    const result = generateAccessibilityTree("all", 5);
    expect(result.error).toBeUndefined();
    expect(result.pageContent).toContain("navigation");
  });
});
