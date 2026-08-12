/**
 * accessibility.ts — shared accessibility foundation for BOTH panels.
 *
 * Live regions, reduced-motion gating, and focus management used across the
 * side panel and the Options page. All helpers are null-safe: they no-op
 * cleanly when the expected DOM nodes are absent (partial fixtures in tests,
 * an Options page without a given panel, etc.).
 *
 * Tested in tests/phase13-a11y.test.ts (live region creation, reduced-motion
 * gating, focus helpers, Tab trap).
 */

/** Query for elements that can receive keyboard focus, in DOM order. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** True when the OS/browser requests reduced motion. */
export function prefersReducedMotion(win: Window = window): boolean {
  try {
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // matchMedia can be missing in exotic embedders; treat as no preference.
    return false;
  }
}

/**
 * Find the live region for a kind: the product's static markup is preferred
 * (sidepanel.html `#runErrorLive`, options.html `#statusMessage`/`#errorMessage`);
 * when absent (partial fixtures, tests), a sr-only region is created lazily.
 * Assertive regions use `role="alert"`, polite ones `role="status"`; both
 * carry `aria-live` + `aria-atomic` so replacement announcements are read as
 * one unit.
 */
const STATIC_REGION_IDS: Record<"polite" | "assertive", string[]> = {
  polite: ["statusMessage", "ocLiveStatus"],
  assertive: ["runErrorLive", "errorMessage", "ocLiveAlert"],
};

export function getLiveRegion(
  kind: "polite" | "assertive",
  doc: Document = document,
): HTMLElement {
  for (const id of STATIC_REGION_IDS[kind]) {
    const existing = doc.getElementById(id);
    if (existing) return existing;
  }
  const role = kind === "assertive" ? "alert" : "status";
  const id = kind === "assertive" ? "ocLiveAlert" : "ocLiveStatus";
  const el = doc.createElement("div");
  el.id = id;
  el.className = "sr-only";
  el.setAttribute("role", role);
  el.setAttribute("aria-live", kind);
  el.setAttribute("aria-atomic", "true");
  doc.body.appendChild(el);
  return el;
}

/**
 * Announce a status/error update to assistive technology. Callers pass the
 * exact message; the helper owns the region, so surfaces never hand-roll
 * `aria-live` markup. `assertive` is reserved for errors and cancellation
 * confirmations (the status bar already announces polite run progress).
 */
export function announce(
  message: string,
  opts: { assertive?: boolean; doc?: Document } = {},
): void {
  const doc = opts.doc ?? document;
  const region = getLiveRegion(opts.assertive ? "assertive" : "polite", doc);
  // Clear + force a layout read before re-populating so an IDENTICAL message
  // re-announces (screen readers treat unchanged textContent as "no update").
  // The read forces the browser to flush the empty state before the new text.
  region.textContent = "";
  void region.getBoundingClientRect();
  region.textContent = message;
}

/** Move focus to an element by id. Returns false when the element is missing. */
export function moveFocusToId(id: string, doc: Document = document): boolean {
  const el = doc.getElementById(id);
  if (!el) return false;
  el.focus();
  return true;
}

/** Move focus to `el` (falling back to the first focusable in `container`). */
export function moveFocusTo(el: HTMLElement | null, container?: HTMLElement): boolean {
  if (el && !("disabled" in el && (el as HTMLButtonElement).disabled)) {
    el.focus();
    return true;
  }
  if (container) {
    const first = getFocusable(container)[0];
    if (first) {
      first.focus();
      return true;
    }
  }
  return false;
}

/**
 * Trap Tab/Shift+Tab inside `container` (ARIA dialog pattern). Used by dialog
 * surfaces that render focusables dynamically; a no-op for every other key.
 *
 * RESERVED (M4): the Options modal (`options/modal.ts`) currently implements
 * its own inline Tab trap with live recomputation, so no production caller
 * uses this helper yet. It is kept for future dialog surfaces (side-panel
 * takeover dialogs, transcript viewers) and remains covered by
 * tests/phase13-a11y.test.ts.
 *
 * `doc` is injectable (M6) so tests never depend on the ambient `document`;
 * callers in production omit it and get the real document.
 */
export function trapTab(
  container: HTMLElement,
  event: KeyboardEvent,
  doc: Document = document,
): void {
  if (event.key !== "Tab") return;
  const focusables = getFocusable(container);
  if (focusables.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = doc.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
