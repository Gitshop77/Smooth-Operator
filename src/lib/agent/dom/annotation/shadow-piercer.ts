/**
 * Shadow-DOM piercer — captures BOTH open and closed shadow roots so the
 * extractor can walk into shadow trees the page tries to hide.
 *
 * ## The problem
 *
 * `Element.prototype.attachShadow({ mode: "closed" })` returns a shadow root
 * that is intentionally inaccessible from outside the host element —
 * `host.shadowRoot` returns `null` for closed roots. Many large SPAs (media
 * sites, social platforms, design-system libraries) attach closed shadow roots
 * to their custom elements specifically to discourage external scraping. The
 * extractor's default `el.shadowRoot` walk therefore misses every interactive
 * element inside those trees.
 *
 * ## The solution
 *
 * Monkey-patch `Element.prototype.attachShadow` BEFORE any page script calls
 * it, storing every shadow root (open or closed) in a `WeakMap<Element,
 * ShadowRoot>`. The patched function is transparent — it calls the real
 * `attachShadow` and returns the real root, it just also records the
 * `(host, root)` pair. The WeakMap is then queried by {@link getShadowRoot}
 * (a drop-in replacement for `el.shadowRoot` that also knows about closed
 * roots) and by {@link pierceShadowRoots} (a flat-tree walker that descends
 * into both open and closed shadow roots).
 *
 * ## Worlds (extension context)
 *
 * In the Chrome extension, the piercer is injected as a separate
 * `shadow-piercer.js` entry point in the MAIN world (before the content
 * script). The MAIN-world instance patches the REAL page's
 * `Element.prototype.attachShadow` and exposes a backdoor on `window` —
 * `window.__openCoworkPiercer__` — that the content script (isolated world)
 * can read via the shared DOM element wrappers. When the module is loaded
 * directly in the content script's isolated world (e.g. during tests or
 * in-page demo mode), the patch is installed locally and the backdoor is
 * set on the content script's own `window`. Both paths produce the same
 * public API: {@link getShadowRoot} and {@link pierceShadowRoots}.
 *
 * ## Idempotency
 *
 * {@link installShadowPiercer} is idempotent — calling it twice is a no-op.
 * The patched `attachShadow` carries a `__openCoworkPatched` sentinel so a
 * second install call detects the existing patch, rebinds the backdoor to
 * the live state, and returns immediately. This matters because the content
 * script may be re-injected on page navigation while the MAIN-world piercer
 * persists.
 *
 * ## Safety
 *
 * - The WeakMap uses `Element` as the key, so hosts are garbage-collected
 *   when they leave the DOM (no leak).
 * - The patch wraps the original `attachShadow` in `try/catch` so a throw
 *   in user code doesn't prevent the root from being recorded.
 * - `Object.defineProperty` is used with `configurable: true, writable: true`
 *   so a page that detects the patch can still override it (the piercer is
 *   best-effort, not a security boundary).
 *
 * Extracted from the historical `dom/shadow-piercer.ts`. The legacy
 * `@/lib/agent/dom/shadow-piercer` import path stays working via a re-export
 * shim in `dom/shadow-piercer.ts`.
 */

// ─── Public types ───────────────────────────────────────────────────────────

/** Options for {@link installShadowPiercer}. */
export interface ShadowPiercerOptions {
  /** If true, walk the current document and tag pre-existing open shadow roots. */
  tagExisting?: boolean;
  /** If true, log each `attachShadow` call to the console (debug only). */
  debug?: boolean;
}

/** Backdoor exposed on `window.__openCoworkPiercer__` for cross-world access. */
export interface ShadowPiercerBackdoor {
  /** Get the closed (or open) shadow root captured for `host`, if any. */
  getShadowRoot(host: Element): ShadowRoot | null;
  /** Whether `host` has a captured shadow root (open or closed). */
  hasShadowRoot(host: Element): boolean;
  /** Aggregate counters (open + closed roots captured so far). */
  stats(): { installed: true; open: number; closed: number };
}

// Internal state — populated by `installShadowPiercer`, read by
// `getShadowRoot` / `pierceShadowRoots`. Kept at module scope so the whole
// module shares one state across the content-script lifetime.
interface PiercerState {
  /** host element → captured shadow root (open or closed). */
  hostToRoot: WeakMap<Element, ShadowRoot>;
  /** Count of open shadow roots captured. */
  openCount: number;
  /** Count of closed shadow roots captured. */
  closedCount: number;
  /** Whether to log each attachShadow call. */
  debug: boolean;
}

let state: PiercerState | null = null;

// `Element` may not exist in non-DOM environments (Node.js without jsdom).
// Guard every reference so the module loads cleanly in any context.
const ELEMENT_CTOR: typeof Element | undefined =
  typeof Element !== "undefined" ? Element : undefined;

// ─── Installation ───────────────────────────────────────────────────────────

/**
 * Patch `Element.prototype.attachShadow` to capture every shadow root the
 * page creates (open or closed). Idempotent — safe to call multiple times.
 *
 * After install, {@link getShadowRoot} returns the captured root for any
 * host, and {@link pierceShadowRoots} walks both open and closed shadow
 * trees. Also exposes the {@link ShadowPiercerBackdoor} on
 * `window.__openCoworkPiercer__` so the content script can read roots
 * captured by a MAIN-world injection of this same module.
 */
export function installShadowPiercer(opts: ShadowPiercerOptions = {}): void {
  if (!ELEMENT_CTOR) return; // non-DOM environment — nothing to pierce.

  // Idempotency: if the prototype already carries our sentinel, just rebind
  // the backdoor to the live state (handles re-injection on navigation).
  const existing = ELEMENT_CTOR.prototype.attachShadow as
    Element["attachShadow"] & { __openCoworkPatched?: boolean; __openCoworkState?: PiercerState };
  if (existing?.__openCoworkPatched && existing.__openCoworkState) {
    state = existing.__openCoworkState;
    state.debug = !!opts.debug;
    bindBackdoor(state);
    return;
  }

  const newState: PiercerState = {
    hostToRoot: new WeakMap<Element, ShadowRoot>(),
    openCount: 0,
    closedCount: 0,
    debug: !!opts.debug,
  };

  const original = existing;
  const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const mode = init?.mode ?? "open";
    // Call the real attachShadow FIRST so the returned root is the genuine
    // article (closed roots return a ShadowRoot either way; we just want to
    // keep our own reference to it).
    const root = original.call(this, init);
    try {
      newState.hostToRoot.set(this, root);
      if (mode === "closed") newState.closedCount++;
      else newState.openCount++;
      if (newState.debug) {
        // Best-effort logging — never let a console call throw the patch.
        try {
          console.info("[open-cowork-piercer] attachShadow", {
            tag: this.tagName?.toLowerCase() ?? "",
            mode,
            url: typeof location !== "undefined" ? location.href : "",
          });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* recording must never throw into the page */
    }
    return root;
  } as Element["attachShadow"] & { __openCoworkPatched?: boolean; __openCoworkState?: PiercerState };

  patched.__openCoworkPatched = true;
  patched.__openCoworkState = newState;

  // Define with configurable + writable so the patch can be overridden by a
  // page that detects it (best-effort, not a security boundary).
  Object.defineProperty(ELEMENT_CTOR.prototype, "attachShadow", {
    configurable: true,
    writable: true,
    value: patched,
  });

  // Optionally walk the current document and record pre-existing open shadow
  // roots (ones created before the piercer was installed). Closed roots
  // created before install are unreachable — there's no way to recover them
  // without the patch in place. This is why the MAIN-world injection must
  // happen at document_start before page scripts run.
  if (opts.tagExisting) {
    try {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode as Element;
        if (el.shadowRoot) {
          newState.hostToRoot.set(el, el.shadowRoot);
          newState.openCount++;
        }
      }
    } catch {
      /* ignore — treeWalker may fail in exotic environments */
    }
  }

  state = newState;
  bindBackdoor(newState);

  if (newState.debug) {
    try {
      console.info("[open-cowork-piercer] installed", {
        url: typeof location !== "undefined" ? location.href : "",
        readyState: typeof document !== "undefined" ? document.readyState : "",
      });
    } catch {
      /* ignore */
    }
  }
}

/** Expose the backdoor on `window` so other worlds/code can read closed roots. */
function bindBackdoor(s: PiercerState): void {
  if (typeof window === "undefined") return;
  const backdoor: ShadowPiercerBackdoor = {
    getShadowRoot: (host: Element): ShadowRoot | null => s.hostToRoot.get(host) ?? null,
    hasShadowRoot: (host: Element): boolean => s.hostToRoot.has(host),
    stats: () => ({ installed: true, open: s.openCount, closed: s.closedCount }),
  };
  try {
    (window as unknown as { __openCoworkPiercer__?: ShadowPiercerBackdoor }).__openCoworkPiercer__ = backdoor;
    (window as unknown as { __openCoworkPiercerInjected?: boolean }).__openCoworkPiercerInjected = true;
  } catch {
    /* window may be non-writable in some sandboxes — ignore */
  }
}

// ─── Public helpers ─────────────────────────────────────────────────────────

/**
 * Get the shadow root of `el`, pierceing closed roots when the piercer is
 * installed. Drop-in replacement for `el.shadowRoot` that ALSO sees closed
 * roots captured by {@link installShadowPiercer}.
 *
 * Resolution order:
 *   1. `el.shadowRoot` — the open root (always accessible from the host).
 *   2. The module-local piercer state (if installed in this world).
 *   3. The cross-world backdoor `window.__openCoworkPiercer__` (set by a
 *      MAIN-world injection of this same module).
 *
 * Returns `null` if no shadow root exists (or the piercer isn't installed
 * and the root is closed).
 */
export function getShadowRoot(el: Element): ShadowRoot | null {
  // Open shadow root — always accessible.
  try {
    if (el.shadowRoot) return el.shadowRoot;
  } catch {
    /* el.shadowRoot can throw on some implementations — fall through */
  }
  // Closed shadow root — read from the module-local state if installed.
  if (state) {
    const root = state.hostToRoot.get(el);
    if (root) return root;
  }
  // Cross-world backdoor (MAIN-world injection set this on the shared window).
  if (typeof window !== "undefined") {
    const backdoor = (window as unknown as { __openCoworkPiercer__?: ShadowPiercerBackdoor }).__openCoworkPiercer__;
    if (backdoor) {
      try {
        const root = backdoor.getShadowRoot(el);
        if (root) return root;
      } catch {
        /* ignore — backdoor may be from a stale injection */
      }
    }
  }
  return null;
}

/**
 * Whether `el` is a shadow host (has any captured shadow root, open or closed).
 */
export function isShadowHost(el: Element): boolean {
  return getShadowRoot(el) !== null;
}

/**
 * Walk the subtree rooted at `root`, descending into BOTH open and closed
 * shadow roots. Returns a flat list of every `Element` encountered, in
 * depth-first source order. Shadow-host elements appear in the list at
 * their light-DOM position; their shadow-tree children follow immediately
 * after the host's light-DOM children.
 *
 * Cycle-safe: a `Set` of visited nodes guards against shadow trees that
 * re-project the same nodes (e.g. via `<slot>` + declarative shadow DOM).
 *
 * @param root the subtree root (Element, Document, or ShadowRoot).
 * @returns a flat `Element[]` including shadow-pierced descendants.
 *
 * LOW-3 note: `pierceShadowRoots` is exported but NOT called in production
 * code (`src/`) — the production walker uses `getShadowRoot` directly. It IS
 * used by tests (`tests/dom-extraction-enhancements.test.ts`) to verify
 * shadow-piercing correctness. Kept as a test-only utility; the production
 * `page-state.ts` walker calls `getShadowRoot` per-element instead.
 */
export function pierceShadowRoots(root: Element | Document | ShadowRoot): Element[] {
  const out: Element[] = [];
  const visited = new Set<Node>();
  walk(root);
  return out;

  function walk(node: Node): void {
    if (!node || visited.has(node)) return;
    visited.add(node);

    if (node.nodeType === (typeof Node !== "undefined" ? Node.ELEMENT_NODE : 1)) {
      out.push(node as Element);
    }

    // Light-DOM children (works for Element, Document, ShadowRoot — all have
    // `childNodes`). `Array.from` snapshots the live NodeList so mutation
    // during the walk doesn't corrupt iteration.
    const childNodes = (node as { childNodes?: NodeListOf<ChildNode> }).childNodes;
    if (childNodes) {
      for (const child of Array.from(childNodes)) {
        walk(child);
      }
    }

    // Shadow DOM — pierce both open and closed roots. Only Elements can be
    // shadow hosts, so guard with an instanceof check (cheap and safe even
    // when `Element` is undefined in non-DOM environments).
    if (ELEMENT_CTOR && node instanceof ELEMENT_CTOR) {
      const sr = getShadowRoot(node);
      if (sr) walk(sr);
    }
  }
}

/**
 * Reset the module-local piercer state. Exposed for tests that re-install
 * the piercer on a fresh document; production code should never call this.
 */
export function _resetShadowPiercerForTests(): void {
  state = null;
  if (typeof window !== "undefined") {
    try {
      delete (window as unknown as { __openCoworkPiercer__?: unknown }).__openCoworkPiercer__;
      delete (window as unknown as { __openCoworkPiercerInjected?: unknown }).__openCoworkPiercerInjected;
    } catch {
      /* ignore */
    }
  }
}
