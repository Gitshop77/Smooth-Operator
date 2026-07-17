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
 // Cache the computed `display` per element so both getters below share a
 // single `getComputedStyle` call (it's the hottest cost in the mock during
 // extraction, which walks hundreds of elements). Display is stable for the
 // duration of a single extraction, so the cache is safe within a test and is
 // discarded on re-install.
  const displayCache = new WeakMap<HTMLElement, "none" | "other">();
  const getDisplay = (el: HTMLElement): "none" | "other" => {
    const cached = displayCache.get(el);
    if (cached) return cached;
    let display: "none" | "other" = "other";
    try {
      if (window.getComputedStyle(el).display === "none") display = "none";
    } catch {
 // getComputedStyle can throw for detached elements; treat as hidden.
      display = "none";
    }
    displayCache.set(el, display);
    return display;
  };

 // 1. `offsetParent` — return body for non-display:none elements so the
 // extractor's `isLikelyHidden` pre-check doesn't short-circuit every
 // visible element. Mirrors real-browser behavior (block elements have
 // body as offsetParent when not positioned).
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement): Element | null {
      return getDisplay(this) === "none" ? null : document.body;
    },
  });

 // 2. `getBoundingClientRect` — return a non-zero rect for non-display:none
 // elements so `isVisibleFull`'s zero-size check doesn't reject them.
 // Real-browser layout would give each element its actual rendered size;
 // we approximate with a fixed 100x30 rect (the dimensions don't matter
 // for any assertion, only that width/height are non-zero).
  const makeRect = (width: number, height: number): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        right: width,
        bottom: height,
        left: 0,
      }),
    }) as DOMRect;

  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    if (getDisplay(this) === "none") return makeRect(0, 0);
    return makeRect(100, 30);
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

// ─── viewport mocks (pageInfo math) ────────────────────────────────────────────
//
// `buildPageInfo` consumes `window.innerHeight`, `document.documentElement.
// scrollHeight`, and `window.scrollY`. jsdom defaults differ from the values a
// real page would report, so tests pin them explicitly. These helpers save the
// originals and restore them, keeping the file's documented "restored in
// afterEach" contract true (a plain `Object.defineProperty` assignment would
// leak the mocked values into later tests).

const viewportOriginals: {
  innerHeight?: number;
  scrollHeight?: number;
  scrollY?: number;
} = {};

export function installViewportMock(values: {
  innerHeight: number;
  scrollHeight: number;
  scrollY: number;
}): void {
  if (viewportOriginals.innerHeight === undefined) viewportOriginals.innerHeight = window.innerHeight;
  if (viewportOriginals.scrollHeight === undefined) viewportOriginals.scrollHeight = document.documentElement.scrollHeight;
  if (viewportOriginals.scrollY === undefined) viewportOriginals.scrollY = window.scrollY;
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: values.innerHeight,
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    writable: true,
    value: values.scrollHeight,
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    writable: true,
    value: values.scrollY,
  });
}

export function restoreViewportMock(): void {
  if (viewportOriginals.innerHeight !== undefined) {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: viewportOriginals.innerHeight,
    });
  }
  if (viewportOriginals.scrollHeight !== undefined) {
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      writable: true,
      value: viewportOriginals.scrollHeight,
    });
  }
  if (viewportOriginals.scrollY !== undefined) {
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      writable: true,
      value: viewportOriginals.scrollY,
    });
  }
  delete viewportOriginals.innerHeight;
  delete viewportOriginals.scrollHeight;
  delete viewportOriginals.scrollY;
}
