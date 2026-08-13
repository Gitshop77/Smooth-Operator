/**
 * Backdoor helpers, constants, and shared types for the shadow-piercer module.
 */

import { isStealthEnabledSync } from "../../anti-detection-utils";

// ─── Internal constants ─────────────────────────────────────────────────────

/** Obscure internal property names — avoid the product name as a detectable fingerprint. */
export const PIERCER_STATE_KEY = "__oc_s__";

/**
 * Symbol key for the cross-world backdoor on `window`. Symbol.for is globally
 * shared across all contexts in the same V8 isolate, so the content script
 * (isolated world) and the MAIN-world injection both resolve the same Symbol.
 */
const PIERCER_BACKDOOR_KEY = Symbol.for("__open_cowork_piercer_bd__");

// ─── Shared types ───────────────────────────────────────────────────────────

/** Options for `installShadowPiercer`. */
export interface ShadowPiercerOptions {
  /** If true, walk the current document and tag pre-existing open shadow roots. */
  tagExisting?: boolean;
  /** If true, log each `attachShadow` call to the console (debug only). */
  debug?: boolean;
}

/** Internal piercer state — populated by `installShadowPiercer`, read by helpers. */
export interface PiercerState {
  /** host element → captured shadow root (open or closed). */
  hostToRoot: WeakMap<Element, ShadowRoot>;
  /** Count of open shadow roots captured. */
  openCount: number;
  /** Count of closed shadow roots captured. */
  closedCount: number;
  /** Whether to log each attachShadow call. */
  debug: boolean;
}

/** Backdoor exposed on `window[Symbol.for("__open_cowork_piercer_bd__")]` for cross-world access. */
export interface ShadowPiercerBackdoor {
  /** Get the closed (or open) shadow root captured for `host`, if any. */
  getShadowRoot(host: Element): ShadowRoot | null;
  /** Aggregate counters (open + closed roots captured so far). */
  stats(): { installed: true; open: number; closed: number };
}

// ─── Backdoor helpers ───────────────────────────────────────────────────────

/** Read the cross-world backdoor from `window`, if present. */
export function readBackdoor(): ShadowPiercerBackdoor | undefined {
  // Stealth gate: the backdoor is a page-observable artifact
  // (`window[Symbol.for("__open_cowork_piercer_bd__")]` — any page script can
  // enumerate it). It is published in NORMAL mode (closed-shadow piercing is a
  // core extraction capability) and SUPPRESSED when stealth mode is on, so a
  // stealth user's page sees no bridge artifact; the piercer then degrades to
  // open shadow roots only (`el.shadowRoot`).
  if (isStealthEnabledSync()) return undefined;
  if (typeof window === "undefined") return undefined;
  return (window as any)[PIERCER_BACKDOOR_KEY] as ShadowPiercerBackdoor | undefined;
}

/** Publish the cross-world backdoor on `window` (best-effort). */
function writeBackdoor(b: ShadowPiercerBackdoor): void {
  if (isStealthEnabledSync()) return;
  try {
    (window as any)[PIERCER_BACKDOOR_KEY] = b;
  } catch {
    /* window may be non-writable in some sandboxes — ignore */
  }
}

/** Clear the cross-world backdoor key (test reset). */
export function clearBackdoorKeys(): void {
  try {
    delete (window as any)[PIERCER_BACKDOOR_KEY];
  } catch {
    /* ignore */
  }
}

/**
 * Expose the backdoor on `window` so other worlds/code can read closed roots.
 * Merges with any pre-existing backdoor instead of clobbering it.
 */
export function bindBackdoor(
  newState: PiercerState,
  existingBackdoor: ShadowPiercerBackdoor | undefined,
): void {
  // Stealth gate — see `writeBackdoor`. The backdoor is suppressed when
  // stealth mode is on; skipping here leaves the attachShadow patch (which
  // records roots in this world's local state) fully functional.
  if (isStealthEnabledSync()) return;
  if (typeof window === "undefined") return;

  // Idempotency guard: if the live backdoor was already built from
  // THIS SAME state, re-binding it would wrap itself — double-counting
  // `stats()` and growing an unbounded backdoor wrapper chain on every
  // re-install.
  if (
    existingBackdoor &&
    (existingBackdoor as any)[PIERCER_STATE_KEY] === newState
  )
    return;

  const backdoor: ShadowPiercerBackdoor & { [PIERCER_STATE_KEY]?: PiercerState } = {
    getShadowRoot: (host: Element): ShadowRoot | null =>
      newState.hostToRoot.get(host) ?? existingBackdoor?.getShadowRoot(host) ?? null,
    stats: () => {
      const prev = existingBackdoor?.stats();
      return {
        installed: true,
        open: (prev?.open ?? 0) + newState.openCount,
        closed: (prev?.closed ?? 0) + newState.closedCount,
      };
    },
  };
  backdoor[PIERCER_STATE_KEY] = newState;
  writeBackdoor(backdoor);
}
