/**
 * `installJsdomLayoutMock` / `restoreJsdomLayoutMock` — install the
 * offsetParent + getBoundingClientRect overrides that let the extractor's
 * visibility checks pass under jsdom (which has no layout engine).
 *
 * jsdom limitations worked around:
 * - `HTMLElement.prototype.offsetParent` is always `null` in jsdom, which
 * makes `isLikelyHidden` (the cheap pre-check in `dom-utils.ts`) return
 * `true` for EVERY element and short-circuit the whole walk. We override
 * the getter to return `document.body` for elements whose computed
 * `display` is not `none` — this mirrors what a real browser does.
 * - `HTMLElement.prototype.getBoundingClientRect` returns a zero-size rect
 * for every element in jsdom, which makes `isVisibleFull`'s
 * `r.width === 0 && r.height === 0` check reject everything. We return a
 * small non-zero rect for non-`display:none` elements (and a zero rect
 * for `display:none` so isVisible tests still work).
 *
 * Was duplicated across three test files:
 * - `tests/ax-tree-dom.test.ts`
 * - `tests/dom-extraction-enhancements.test.ts`
 * - `tests/extractor.test.ts`
 *
 * Usage:
 * beforeEach(() => {
 * document.body.innerHTML = "";
 * // ... your file-specific setup ...
 * installJsdomLayoutMock();
 * });
 * afterEach(() => {
 * restoreJsdomLayoutMock();
 * });
 *
 * `executor.test.ts` uses a DIFFERENT variant (scrollIntoView + innerText +
 * getBoundingClientRect) — it stays inline because the extra mocks aren't
 * shared with the other files.
 */

const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const offsetParentDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
);

/** Install the layout mocks. Safe to call multiple times — each call overwrites the previous. */
export function installJsdomLayoutMock(): void {
 // 1. `offsetParent` — return body for non-display:none elements so the
 // extractor's `isLikelyHidden` pre-check doesn't short-circuit every
 // visible element. Mirrors real-browser behavior (block elements have
 // body as offsetParent when not positioned).
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement): Element | null {
      try {
        if (window.getComputedStyle(this).display === "none") return null;
      } catch {
 // getComputedStyle can throw for detached elements; treat as hidden.
        return null;
      }
      return document.body;
    },
  });

 // 2. `getBoundingClientRect` — return a non-zero rect for non-display:none
 // elements so `isVisibleFull`'s zero-size check doesn't reject them.
 // Real-browser layout would give each element its actual rendered size;
 // we approximate with a fixed 100x30 rect (the dimensions don't matter
 // for any assertion, only that width/height are non-zero).
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    try {
      if (window.getComputedStyle(this).display === "none") {
        return {
          width: 0,
          height: 0,
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
    } catch {
 // detached — return zero rect
      return {
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 30,
      left: 0,
      width: 100,
      height: 30,
      toJSON: () => ({}) as DOMRect,
    } as DOMRect;
  };
}

/** Restore the original prototypes — call in `afterEach` so the mocks don't leak to other test files. */
export function restoreJsdomLayoutMock(): void {
  HTMLElement.prototype.getBoundingClientRect = origGetBoundingClientRect;
  if (offsetParentDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetParent",
      offsetParentDescriptor,
    );
  } else {
    delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
  }
}
