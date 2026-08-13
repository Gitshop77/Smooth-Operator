/**
 * Visual overlay — transient highlights + status banners drawn on top of the
 * page so the user can see what the agent is interacting with.
 *
 * All overlay DOM is appended to `document.body` with a very high z-index and
 * `pointer-events: none` so it never interferes with the page itself.
 *
 * Extracted from the historical `dom/overlay.ts`. The legacy
 * `@/lib/agent/dom/overlay` import path stays working via a re-export shim
 * in `dom/overlay.ts`.
 */

import { isStealthEnabledSync } from "../../anti-detection-utils";

/** Color used for highlight outlines + badge backgrounds. */
const HIGHLIGHT_COLOR = "#f97316";
/** Background tint applied to a highlighted element. */
const HIGHLIGHT_BG = "rgba(249,115,22,0.12)";
/** How long a highlight stays on screen before auto-removing. */
const HIGHLIGHT_DURATION_MS = 1200;
/** Maximum z-index (used for highlight badges). Sub-max to avoid the literal
 * 2147483647 automation fingerprint while still sitting above essentially all
 * page content. */
const MAX_Z_INDEX = "2147483000";
/** Vertical offset of the badge above the element (px). */
const BADGE_VERTICAL_OFFSET = 22;
/** Minimum left/top coordinate for the badge (px). */
const BADGE_MIN_COORD = 4;

/** Handle returned by {@link highlightElement}; call `remove()` to clear early. */
export interface OverlayHandle {
  /** Remove the highlight + listeners (idempotent). */
  remove: () => void;
}

/**
 * Per-element ownership tracking so overlapping highlights restore correctly.
 *
 * The first highlight on an element captures + applies the highlight styles;
 * subsequent highlights on the same element reuse the already-applied styles
 * without re-capturing the "original" ones. The original styles are only
 * restored when the *last* active highlight for that element is removed, which
 * prevents a stale `outline`/`backgroundColor` from being left on the page
 * when two highlights target the same element.
 */
interface ElementHighlightState {
  prevOutline: string;
  prevOffset: string;
  prevBg: string;
  count: number;
}

const elementHighlights = new WeakMap<HTMLElement, ElementHighlightState>();

/**
 * Single memoized visually-hidden `aria-live` region that announces which
 * element the agent is acting on, so screen-reader users can follow the
 * agent's actions (the visual badge stays `aria-hidden`/decorative).
 */
let liveRegion: HTMLElement | null = null;
function announceAction(label: string): void {
  // Recreate the region if it was detached (e.g. a page framework replaced
  // `document.body` mid-session); a detached region would silently swallow
  // every announcement from then on.
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.style.cssText = [
      "position:absolute",
      "width:1px",
      "height:1px",
      "margin:-1px",
      "padding:0",
      "border:0",
      "overflow:hidden",
      "clip:rect(0 0 0 0)",
      "white-space:nowrap",
    ].join(";");
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = label;
}

/**
 * Highlight an element with an orange outline + a floating label badge.
 * The highlight auto-removes after {@link HIGHLIGHT_DURATION_MS} milliseconds
 * (or sooner via the returned handle).
 *
 * @param el The element to highlight.
 * @param label Text shown in the floating badge (typically the action summary).
 * @returns A handle whose `remove()` clears the highlight immediately.
 */
export function highlightElement(el: HTMLElement, label: string): OverlayHandle {
  // Stealth gate: the overlay is page-visible chrome (outline styles, floating
  // badges, an aria-live region — all observable by page scripts). It renders
  // in NORMAL mode (the user's visual + assistive feedback for "the agent is
  // acting on this element") and is SUPPRESSED when stealth mode is on, so a
  // stealth user's page sees no automation artifacts. When suppressed, return
  // a no-op handle so the caller contract (OverlayHandle) is preserved without
  // touching the page.
  if (isStealthEnabledSync()) return { remove: () => { /* no-op */ } };
  // Track ownership per element so overlapping highlights don't corrupt style
 // restoration. The first highlight captures + applies the styles; later
 // highlights on the same element reuse the applied styles and only restore
 // the originals once the last highlight for that element is removed.
  let state = elementHighlights.get(el);
  if (!state) {
    state = {
      prevOutline: el.style.outline,
      prevOffset: el.style.outlineOffset,
      prevBg: el.style.backgroundColor,
      count: 0,
    };
    elementHighlights.set(el, state);
    el.style.outline = `3px solid ${HIGHLIGHT_COLOR}`;
    el.style.outlineOffset = "1px";
    el.style.backgroundColor = HIGHLIGHT_BG;
  }
  state.count += 1;

  const badge = document.createElement("div");
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = label;
 // Announce the action to assistive technology (the badge is decorative).
  announceAction(label);
  badge.style.cssText = [
    "position:fixed",
    `z-index:${MAX_Z_INDEX}`,
    `background:${HIGHLIGHT_COLOR}`,
    "color:#fff",
    "font:600 12px/1.2 ui-sans-serif,system-ui",
    "padding:3px 7px",
    "border-radius:6px",
    "box-shadow:0 2px 8px rgba(0,0,0,.35)",
    "pointer-events:none",
    "white-space:nowrap",
  ].join(";");

  /** Reposition the badge relative to the element's current rect. */
  const position = (): void => {
    const rect = el.getBoundingClientRect();
    badge.style.left = `${Math.max(BADGE_MIN_COORD, rect.left)}px`;
    badge.style.top = `${Math.max(BADGE_MIN_COORD, rect.top - BADGE_VERTICAL_OFFSET)}px`;
  };
  position();
  document.body.appendChild(badge);

 // Coalesce scroll/resize events into at most one reposition per animation
 // frame (avoids synchronous layout reads on the scroll hot path). Capture
 // phase catches non-bubbling scroll events from nested scrollable containers
 // — a position:fixed badge must follow the element in the viewport even when
 // an inner container scrolls.
  let rafId: number | null = null;
  const schedulePosition = (): void => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      position();
    });
  };
  window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
  window.addEventListener("resize", schedulePosition, { passive: true });

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    state.count -= 1;
    badge.remove();
    window.removeEventListener("scroll", schedulePosition, { capture: true });
    window.removeEventListener("resize", schedulePosition);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
 // Only restore the element's original styles when this was the last
 // active highlight for it, preventing a stale highlight from lingering.
    if (state.count === 0) {
      el.style.outline = state.prevOutline;
      el.style.outlineOffset = state.prevOffset;
      el.style.backgroundColor = state.prevBg;
      elementHighlights.delete(el);
    }
  };

  // Highlights always auto-remove after HIGHLIGHT_DURATION_MS (the executor
  // also calls remove() on the previous highlight before adding a new one,
  // which clears it early when actions run back-to-back).
  setTimeout(remove, HIGHLIGHT_DURATION_MS);
  return { remove };
}

// NOTE: a `showStatusBanner` helper previously lived here but had no callers
// (production or test) and was removed to shrink the public API. Re-add it
// only if a status-reporting path actually wires it up.
