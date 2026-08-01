/**
 * Backdoor helpers, constants, and shared types for the shadow-piercer module.
 */

// ─── Internal constants ─────────────────────────────────────────────────────

/** Obscure internal property names — avoid the product name as a detectable fingerprint. */
export const PIERCER_STATE_KEY = "__oc_s__";

/** Marker set on `window` after backdoor injection (best-effort). */
const PIERCER_INJECTED_KEY = "__oc_in__";

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
  /** Whether `host` has a captured shadow root (open or closed). */
  hasShadowRoot(host: Element): boolean;
  /** Aggregate counters (open + closed roots captured so far). */
  stats(): { installed: true; open: number; closed: number };
}

// ─── Backdoor helpers ───────────────────────────────────────────────────────

/** Read the cross-world backdoor from `window`, if present. */
export function readBackdoor(): ShadowPiercerBackdoor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as any)[PIERCER_BACKDOOR_KEY] as ShadowPiercerBackdoor | undefined;
}

/** Publish the cross-world backdoor on `window` (best-effort). */
function writeBackdoor(b: ShadowPiercerBackdoor): void {
  try {
    (window as any)[PIERCER_BACKDOOR_KEY] = b;
  } catch {
    /* window may be non-writable in some sandboxes — ignore */
  }
}

/** Mark that the backdoor has been injected (best-effort). */
function markInjected(): void {
  try {
    (window as unknown as Record<string, unknown>)[PIERCER_INJECTED_KEY] = true;
  } catch {
    /* window may be non-writable in some sandboxes — ignore */
  }
}

/** Clear the cross-world backdoor keys (test reset). */
export function clearBackdoorKeys(): void {
  try {
    delete (window as any)[PIERCER_BACKDOOR_KEY];
    delete (window as unknown as Record<string, unknown>)[PIERCER_INJECTED_KEY];
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
    hasShadowRoot: (host: Element): boolean =>
      newState.hostToRoot.has(host) || (existingBackdoor?.hasShadowRoot(host) ?? false),
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
  markInjected();
}
