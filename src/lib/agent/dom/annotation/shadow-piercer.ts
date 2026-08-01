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
 * `Element.prototype.attachShadow` and exposes a backdoor on `window` via
 * a Symbol key — `window[Symbol.for("__open_cowork_piercer_bd__")]` — that
 * the content script (isolated world) can read via the shared DOM element
 * wrappers. When the module is loaded directly in the content script's
 * isolated world (e.g. during tests or in-page demo mode), the patch is
 * installed locally and the backdoor is set on the content script's own
 * `window`. Both paths produce the same public API: {@link getShadowRoot}
 * and {@link pierceShadowRoots}.
 *
 * ## Idempotency
 *
 * {@link installShadowPiercer} is idempotent — calling it twice is a no-op.
 * The patched `attachShadow` carries a `__oc_p__` sentinel so a
 * second install call detects the existing patch, rebinds the backdoor to
 * the live state, and returns immediately. This matters because the content
 * script may be re-injected on page navigation while the MAIN-world piercer
 * persists.
 *
 * ## Safety
 *
 * - The WeakMap uses `Element` as the key, so hosts are garbage-collected
 * when they leave the DOM (no leak).
 * - The patch wraps the original `attachShadow` in `try/catch` so a throw
 * in user code doesn't prevent the root from being recorded.
 * - `Object.defineProperty` is used with `configurable: true, writable: true`
 * so a page that detects the patch can still override it (the piercer is
 * best-effort, not a security boundary).
 * - The cross-world backdoor `window[Symbol.for("__open_cowork_piercer_bd__")]`
 * is written to the SHARED `window` (see "Worlds" above). Because it lives on
 * the page's `window`, the page's own MAIN-world scripts can also read it —
 * including any closed shadow roots the page author attached (the page only
 * learns its OWN closed roots, never another origin's). This is a deliberate,
 * low-impact trade-off: the backdoor exists so the isolated-world content
 * script can reach roots captured by the MAIN-world injection. It is NOT a
 * secret channel; treat it as read-only page introspection support, not a
 * security boundary.
 *
 * Extracted from the historical `dom/shadow-piercer.ts`. The legacy
 * `@/lib/agent/dom/shadow-piercer` import path stays working via a re-export
 * shim in `dom/shadow-piercer.ts`.
 */

import { redactUrlTokens } from "../extraction/element-info-utils";
import {
  PIERCER_STATE_KEY,
  type PiercerState,
  type ShadowPiercerOptions,
  readBackdoor,
  clearBackdoorKeys,
  bindBackdoor,
} from "./shadow-piercer-utils";

// ─── Local constants ────────────────────────────────────────────────────────

const PIERCER_PATCHED_KEY = "__oc_p__";
const PIERCER_LOG_TAG = "[oc-piercer]";
const MAX_PIERCE_DEPTH = 512;
const ELEMENT_CTOR: typeof Element | undefined =
  typeof Element !== "undefined" ? Element : undefined;

// Re-export public types so existing import paths keep working.
export type { ShadowPiercerBackdoor, ShadowPiercerOptions } from "./shadow-piercer-utils";

// ─── Internal state ─────────────────────────────────────────────────────────

let state: PiercerState | null = null;

// ─── Installation ───────────────────────────────────────────────────────────

/**
 * Patch `Element.prototype.attachShadow` to capture every shadow root the
 * page creates (open or closed). Idempotent — safe to call multiple times.
 *
 * After install, {@link getShadowRoot} returns the captured root for any
 * host, and {@link pierceShadowRoots} walks both open and closed shadow
 * trees. Also exposes the {@link ShadowPiercerBackdoor} on
 * `window[Symbol.for("__open_cowork_piercer_bd__")]` so the content script
 * can read roots captured by a MAIN-world injection of this same module.
 */
export function installShadowPiercer(opts: ShadowPiercerOptions = {}): void {
  if (!ELEMENT_CTOR) return;

  const existing = ELEMENT_CTOR.prototype.attachShadow as
    Element["attachShadow"] & { [PIERCER_PATCHED_KEY]?: boolean; [PIERCER_STATE_KEY]?: PiercerState };
  if (existing?.[PIERCER_PATCHED_KEY] && existing[PIERCER_STATE_KEY]) {
    state = existing[PIERCER_STATE_KEY];
    state.debug = !!opts.debug;
    bindBackdoor(state, readBackdoor());
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
    const root = original.call(this, init);
    try {
      newState.hostToRoot.set(this, root);
      if (mode === "closed") newState.closedCount++;
      else newState.openCount++;
      if (newState.debug) {
        try {
          console.info(`${PIERCER_LOG_TAG} attachShadow`, {
            tag: this.tagName?.toLowerCase() ?? "",
            mode,
            url: typeof location !== "undefined" ? redactUrlTokens(location.href) : "",
          });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* recording must never throw into the page */
    }
    return root;
  } as Element["attachShadow"] & { [PIERCER_PATCHED_KEY]?: boolean; [PIERCER_STATE_KEY]?: PiercerState };

  patched[PIERCER_PATCHED_KEY] = true;
  patched[PIERCER_STATE_KEY] = newState;

  patched.toString = original.toString.bind(original);
  Object.defineProperty(patched, "name", { value: "attachShadow", configurable: true });
  patched.prototype = undefined;

  Object.defineProperty(ELEMENT_CTOR.prototype, "attachShadow", {
    configurable: true,
    writable: true,
    value: patched,
  });

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
    } catch (err) {
      if (newState.debug) {
        try {
          console.warn(`${PIERCER_LOG_TAG} tagExisting tree walk failed`, err);
        } catch {
          /* ignore — console must never throw */
        }
      }
    }
  }

  state = newState;
  bindBackdoor(newState, readBackdoor());

  if (newState.debug) {
    try {
      console.info(`${PIERCER_LOG_TAG} installed`, {
        url: typeof location !== "undefined" ? redactUrlTokens(location.href) : "",
        readyState: typeof document !== "undefined" ? document.readyState : "",
      });
    } catch {
      /* ignore */
    }
  }
}

// ─── Public helpers ─────────────────────────────────────────────────────────

/**
 * Get the shadow root of `el`, pierceing closed roots when the piercer is
 * installed. Drop-in replacement for `el.shadowRoot` that ALSO sees closed
 * roots captured by {@link installShadowPiercer}.
 *
 * Resolution order:
 * 1. `el.shadowRoot` — the open root (always accessible from the host).
 * 2. The module-local piercer state (if installed in this world).
 * 3. The cross-world backdoor `window[Symbol.for("__open_cowork_piercer_bd__")]`
 * (set by a MAIN-world injection of this same module).
 *
 * Returns `null` if no shadow root exists (or the piercer isn't installed
 * and the root is closed).
 */
export function getShadowRoot(el: Element): ShadowRoot | null {
  try {
    if (el.shadowRoot) return el.shadowRoot;
  } catch {
    /* el.shadowRoot can throw on some implementations — fall through */
  }
  if (state) {
    const root = state.hostToRoot.get(el);
    if (root) return root;
  }
  if (typeof window !== "undefined") {
    const backdoor = readBackdoor();
    if (backdoor) {
      try {
        const root = backdoor.getShadowRoot(el);
        if (root instanceof ShadowRoot) return root;
        const srChildNodes = (root as unknown as { childNodes?: unknown }).childNodes;
        if (
          typeof Node !== "undefined" &&
          root &&
          (root as Node).nodeType === (Node.DOCUMENT_FRAGMENT_NODE ?? 11) &&
          (root as { host?: unknown }).host === el &&
          srChildNodes != null &&
          typeof (srChildNodes as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
        ) {
          return root as unknown as ShadowRoot;
        }
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
 * @internal Test-only helper. NOT called by production code in `src/` — the
 * production walker (`page-state.ts`) calls {@link getShadowRoot} per-element
 * instead. It is exercised only by unit tests. Do not rely on it in shipped
 * code; it is maintained as a test utility, deliberately NOT a second
 * production walker, so the `visited`/cycle logic cannot drift from the
 * production path.
 *
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
  const elementNodeType = typeof Node !== "undefined" ? Node.ELEMENT_NODE : 1;

  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!node || visited.has(node)) continue;
    visited.add(node);

    if (node.nodeType === elementNodeType) {
      out.push(node as Element);
    }

    if (depth >= MAX_PIERCE_DEPTH) continue;

    const children: Node[] = [];

    // firstChild/nextSibling instead of `childNodes` (indexed access on a live
    // NodeList re-snapshots it in jsdom — quadratic under bulk mutations).
    for (let child = node.firstChild; child; child = child.nextSibling) {
      children.push(child);
    }

    if (ELEMENT_CTOR && node instanceof ELEMENT_CTOR) {
      const sr = getShadowRoot(node);
      if (sr) children.push(sr);
    }

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: depth + 1 });
    }
  }

  return out;
}

/**
 * Reset the module-local piercer state. Exposed for tests that re-install
 * the piercer on a fresh document; production code should never call this.
 */
export function _resetShadowPiercerForTests(): void {
  if (typeof window !== "undefined") {
    try {
      clearBackdoorKeys();
    } catch {
      /* ignore */
    }
  }
  if (ELEMENT_CTOR) {
    try {
      delete (ELEMENT_CTOR.prototype.attachShadow as unknown as Record<string, unknown>)[PIERCER_PATCHED_KEY];
    } catch {
      /* ignore */
    }
  }
  state = null;
}
