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
 * `window.__oc_bd__` — that the content script (isolated world)
 * can read via the shared DOM element wrappers. When the module is loaded
 * directly in the content script's isolated world (e.g. during tests or
 * in-page demo mode), the patch is installed locally and the backdoor is
 * set on the content script's own `window`. Both paths produce the same
 * public API: {@link getShadowRoot} and {@link pierceShadowRoots}.
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
 * - The cross-world backdoor `window.__oc_bd__` is written to the
 * SHARED `window` (see "Worlds" above). Because it lives on the page's
 * `window`, the page's own MAIN-world scripts can also read it — including
 * any closed shadow roots the page author attached (the page only learns its
 * OWN closed roots, never another origin's). This is a deliberate,
 * low-impact trade-off: the backdoor exists so the isolated-world content
 * script can reach roots captured by the MAIN-world injection. It is NOT a
 * secret channel; treat it as read-only page introspection support, not a
 * security boundary.
 *
 * Extracted from the historical `dom/shadow-piercer.ts`. The legacy
 * `@/lib/agent/dom/shadow-piercer` import path stays working via a re-export
 * shim in `dom/shadow-piercer.ts`.
 */

import { redactUrlTokens } from "../extraction/element-info";

// ─── Public types ───────────────────────────────────────────────────────────

/** Options for {@link installShadowPiercer}. */
export interface ShadowPiercerOptions {
  /** If true, walk the current document and tag pre-existing open shadow roots. */
  tagExisting?: boolean;
  /** If true, log each `attachShadow` call to the console (debug only). */
  debug?: boolean;
}

/** Backdoor exposed on `window.__oc_bd__` for cross-world access. */
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

// Obscure internal property names — avoid the product name as a detectable
// fingerprint that page bot-detection can scan for on `Element.prototype` or
// `window`.
const PIERCER_PATCHED_KEY = "__oc_p__";
const PIERCER_STATE_KEY = "__oc_s__";
const PIERCER_BACKDOOR_KEY = "__oc_bd__";
const PIERCER_INJECTED_KEY = "__oc_in__";
// Neutral, opaque console prefix for debug-only logs — never embeds the
// product name, so the page console can't be fingerprinted by that string.
const PIERCER_LOG_TAG = "[oc-piercer]";

/**
 * Hard cap on traversal depth for {@link pierceShadowRoots}. No legitimate
 * page approaches this depth; the cap only guards against adversarial /
 * cyclic deep nesting so the walker can't run unbounded. (pierceShadowRoots
 * is test-only — see its docstring — but the bound is kept tight regardless.)
 */
const MAX_PIERCE_DEPTH = 512;

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
 * `window.__oc_bd__` so the content script can read roots
 * captured by a MAIN-world injection of this same module.
 */
export function installShadowPiercer(opts: ShadowPiercerOptions = {}): void {
  if (!ELEMENT_CTOR) return; // non-DOM environment — nothing to pierce.

 // Idempotency: if the prototype already carries our sentinel, just rebind
 // the backdoor to the live state (handles re-injection on navigation).
  const existing = ELEMENT_CTOR.prototype.attachShadow as
    Element["attachShadow"] & { [PIERCER_PATCHED_KEY]?: boolean; [PIERCER_STATE_KEY]?: PiercerState };
  if (existing?.[PIERCER_PATCHED_KEY] && existing[PIERCER_STATE_KEY]) {
    state = existing[PIERCER_STATE_KEY];
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

 // Hide the patch from Function.prototype.toString-based tamper detection:
 // expose the native attachShadow's toString so the replacement reads as a
 // built-in rather than a hook.
  patched.toString = original.toString.bind(original);
 // Mirror the native method's own descriptors: a patched plain function has
 // `.name === ""` and a real `.prototype` object, whereas the built-in
 // `attachShadow` has `.name === "attachShadow"` and `.prototype === undefined`.
 // Detectors that inspect these would otherwise flag the hook. Both are no-ops
 // for callers (attachShadow is never used as a constructor).
 // `.name` is configurable so it can be redefined; `.prototype` is NOT
 // configurable on a function (a `defineProperty` would throw), but it is
 // writable — assign it directly to mirror the native `undefined` value.
  Object.defineProperty(patched, "name", { value: "attachShadow", configurable: true });
  patched.prototype = undefined;

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
    } catch (err) {
 // treeWalker may fail in exotic environments; fail silently in prod but
 // surface it in debug builds so the feature's failure is observable.
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
  bindBackdoor(newState);

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

/** Backdoor tagged with the state it was directly built from (idempotency guard). */
type TaggedBackdoor = ShadowPiercerBackdoor & { [PIERCER_STATE_KEY]?: PiercerState };

/** Read the cross-world backdoor, if present, as a {@link TaggedBackdoor}. */
function readTaggedBackdoor(): TaggedBackdoor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, TaggedBackdoor | undefined>)[PIERCER_BACKDOOR_KEY];
}

/** Read the cross-world backdoor, if present, as a {@link ShadowPiercerBackdoor}. */
function readBackdoor(): ShadowPiercerBackdoor | undefined {
  return readTaggedBackdoor() as ShadowPiercerBackdoor | undefined;
}

/**
 * Module-scope cache of the resolved cross-world backdoor. `getShadowRoot`
 * reads it on the hot path (per element) instead of re-reading the `window`
 * property on every miss, then falls back to {@link readBackdoor} if unset.
 */
let cachedBackdoor: TaggedBackdoor | undefined;

/** Publish the cross-world backdoor on `window` (best-effort). */
function writeBackdoor(b: TaggedBackdoor): void {
  try {
    (window as unknown as Record<string, unknown>)[PIERCER_BACKDOOR_KEY] = b;
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
function clearBackdoorKeys(): void {
  cachedBackdoor = undefined;
  try {
    delete (window as unknown as Record<string, unknown>)[PIERCER_BACKDOOR_KEY];
    delete (window as unknown as Record<string, unknown>)[PIERCER_INJECTED_KEY];
  } catch {
    /* ignore */
  }
}

/** Expose the backdoor on `window` so other worlds/code can read closed roots. */
function bindBackdoor(s: PiercerState): void {
  if (typeof window === "undefined") return;
 // Merge with any pre-existing backdoor instead of clobbering it. The MAIN-
 // world injection captures the page's closed shadow roots into ITS state and
 // publishes a backdoor here; if the content script (or a re-injection)
 // re-binds, an unconditional overwrite would discard those captured roots
 // and break piercing in production. The combined accessor reads BOTH the
 // local state and any backdoor that was already on `window`.
  const existing = readTaggedBackdoor();

 // Idempotency guard : if the live backdoor was already built from
 // THIS SAME state, re-binding it would wrap itself — double-counting
 // `stats()` and growing an unbounded backdoor wrapper chain on every
 // re-install. The existing backdoor already reflects `s`, so bail out.
  if (existing && existing[PIERCER_STATE_KEY] === s) return;

  const backdoor: TaggedBackdoor = {
    getShadowRoot: (host: Element): ShadowRoot | null =>
      s.hostToRoot.get(host) ?? existing?.getShadowRoot(host) ?? null,
    hasShadowRoot: (host: Element): boolean =>
      s.hostToRoot.has(host) || (existing?.hasShadowRoot(host) ?? false),
    stats: () => {
      const prev = existing?.stats();
      return {
        installed: true,
        open: (prev?.open ?? 0) + s.openCount,
        closed: (prev?.closed ?? 0) + s.closedCount,
      };
    },
  };
  backdoor[PIERCER_STATE_KEY] = s;
  writeBackdoor(backdoor);
  cachedBackdoor = backdoor;
  markInjected();
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
 * 3. The cross-world backdoor `window.__oc_bd__` (set by a
 * MAIN-world injection of this same module).
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
 // The page's MAIN world can overwrite the backdoor, so treat its return value
 // as untrusted: only accept a genuine `ShadowRoot` (or a node of the right
 // `nodeType`), otherwise an attacker-supplied fake node would be walked by the
 // extractor. Defense-in-depth against a fabricated-DOM injection.
  if (typeof window !== "undefined") {
    const backdoor = cachedBackdoor ?? readBackdoor();
    if (backdoor) {
      try {
        const root = backdoor.getShadowRoot(el);
        if (root instanceof ShadowRoot) return root;
 // Cross-world / non-instanceof fallback: a genuine ShadowRoot is a
 // DOCUMENT_FRAGMENT_NODE that ALSO exposes a `host` (the element it is
 // attached to) and a real, iterable `childNodes` collection. Requiring
 // `host` distinguishes a real ShadowRoot from a fabricated
 // `DocumentFragment` (which lacks `host`), and the iterable `childNodes`
 // check rejects attacker-supplied fake nodes that only mimic the shape
 // (e.g. `{nodeType:11, host:{}}`) — otherwise the extractor would try to
 // walk them and throw on `Array.from(sr.childNodes)`.
        const srChildNodes = (root as unknown as { childNodes?: unknown }).childNodes;
        if (
          typeof Node !== "undefined" &&
          root &&
          (root as Node).nodeType === (Node.DOCUMENT_FRAGMENT_NODE ?? 11) &&
          (root as { host?: unknown }).host &&
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

 // Iterative DFS with an explicit stack : a recursive walk overflows
 // the call stack on pathologically deep shadow/light DOM trees. The explicit
 // stack removes that limit, `visited` guards re-projected/cyclic nodes, and
 // `MAX_PIERCE_DEPTH` caps descent so a truly unbounded tree can't run forever.
  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!node || visited.has(node)) continue;
    visited.add(node);

    if (node.nodeType === elementNodeType) {
      out.push(node as Element);
    }

 // Stop descending past the depth cap, but keep processing the rest of the
 // stack (already-queued siblings/subtrees are still emitted).
    if (depth >= MAX_PIERCE_DEPTH) continue;

 // Collect this node's descendants (light-DOM children, then shadow root),
 // then push them in reverse so they pop in depth-first source order —
 // matching the previous recursive traversal exactly.
    const children: Node[] = [];

 // Light-DOM children (works for Element, Document, ShadowRoot — all have
 // `childNodes`). `Array.from` snapshots the live NodeList so mutation
 // during the walk doesn't corrupt iteration.
    const childNodes = (node as { childNodes?: NodeListOf<ChildNode> }).childNodes;
    if (childNodes) {
      for (let i = 0; i < childNodes.length; i++) {
        children.push(childNodes[i]);
      }
    }

 // Shadow DOM — pierce both open and closed roots. Only Elements can be
 // shadow hosts, so guard with an instanceof check (cheap and safe even
 // when `Element` is undefined in non-DOM environments).
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
  state = null;
  if (typeof window !== "undefined") {
    try {
      clearBackdoorKeys();
    } catch {
      /* ignore */
    }
  }
}
