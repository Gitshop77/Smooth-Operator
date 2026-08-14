/**
 * Global test-isolation teardown.
 *
 * vitest v4 ignores the `isolate: true` option in vitest.config.ts, so when the
 * suite runs in a shared module context the `globalThis`-level globals that some
 * test files install (`globalThis.chrome` and DOM mutations in `document.body`)
 * can leak into later test files and break otherwise-correct tests (e.g. a
 * leaked `globalThis.chrome` makes `secrets.listSecrets` call a stubbed
 * `chrome.storage.session.get` that returns `undefined`, throwing and masking
 * real secret redaction; a leaked `document.body` pollutes the ax-tree walk).
 *
 * This setup file restores the per-file isolation the config intends by
 * resetting the known leak vectors after each test file runs. It does NOT touch
 * any security logic — it only clears ambient globals between files so each
 * file sees a clean environment, exactly as it would under true isolation.
 */

import { afterAll, afterEach } from "vitest";

// Install a functional Map-backed `localStorage` stub for the entire test file.
//
// Under jsdom v29 on Node ≥22, the native `localStorage` getter delegates to
// Node's built-in webstorage, which (a) emits a benign-but-noisy
// "--localstorage-file was provided without a valid path" warning on EVERY
// access and (b) returns a store without `setItem`/`getItem`. Replacing the
// getter with a working stub silences that warning everywhere — this file's
// reset below, the `local-storage-stub` helper, and any module under test that
// falls back to `localStorage` (secrets, persistent-memory) — and gives those
// modules a real store. We DEFINE the property rather than reading the old one
// first, so we never invoke the warning-emitting getter. Isolating the stub
// per file (vitest `isolate: true`) keeps it from leaking across files.
(function installGlobalLocalStorageStub() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  const w = (globalThis as { window?: { localStorage?: unknown } }).window;
  if (w) {
    Object.defineProperty(w, "localStorage", {
      value: stub,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
})();

// Install a no-op IntersectionObserver stub.
//
// jsdom implements no IntersectionObserver (jsdom#2032), but the
// ViewportTracker (src/lib/agent/dom/viewport-tracker.ts) constructs one per
// tracker to cache viewport membership across extraction steps. This stub
// keeps the tracker constructible in every test file while doing nothing:
// `observe`/`unobserve`/`disconnect` never fire the callback, so
// `isInViewport` stays `undefined` (unknown) everywhere except the tracker
// tests, which retrieve the last-constructed stub via the `__ocLastIO` handle
// and drive its stored callback with fake `isIntersecting` entries.
//
// Safety for ALL test files: the constructor stores the callback and does not
// invoke it; no other module in the suite uses IntersectionObserver, so the
// stub can neither fire spurious entries nor change fallback behavior. The
// property is configurable/writable so a test can delete it to exercise the
// IO-unavailable path and restore it afterwards.
interface IOStubInstance {
  callback: IntersectionObserverCallback;
  root: Element | Document | null;
  observed: Element[];
}
class IntersectionObserverStub implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin = "0px";
  readonly thresholds: ReadonlyArray<number> = [0];
  readonly callback: IntersectionObserverCallback;
  readonly observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    // Expose the instance so tracker tests can drive `callback` with fake
    // intersection entries (`isIntersecting: true/false`).
    (globalThis as { __ocLastIO?: IOStubInstance }).__ocLastIO = this;
  }

  observe(target: Element): void {
    if (!this.observed.includes(target)) this.observed.push(target);
  }

  unobserve(target: Element): void {
    const i = this.observed.indexOf(target);
    if (i !== -1) this.observed.splice(i, 1);
  }

  disconnect(): void {
    this.observed.length = 0;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
(function installIntersectionObserverStub() {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    value: IntersectionObserverStub,
    configurable: true,
    writable: true,
    enumerable: true,
  });
})();
// Drop the last-stub handle after each test so a test that constructs a
// tracker can never reach the previous test's stub instance.
afterEach(() => {
  delete (globalThis as { __ocLastIO?: unknown }).__ocLastIO;
});

// Capture the ambient `fetch` once, from a PRISTINE source, so we can
// restore it after the file runs. Some test files install a `globalThis.fetch`
// mock; if they don't fully clean it up, the mock leaks into later files and
// breaks otherwise-correct tests (e.g. the per-IP /chat rate-limit integration
// test, which makes real `fetch()` calls against its own server).
//
// vitest may re-execute this setup file per test file, so a naive per-file
// capture would snapshot a mock leaked by an EARLIER file and re-leak it. We
// therefore capture the genuine `fetch` exactly once (on the first import, before
// any mock can be installed) and keep it on a persistent global, so every
// later file's restore returns the real implementation, not a leaked mock.
const g = globalThis as { fetch?: unknown; __OC_ORIG_FETCH__?: unknown };
if (g.__OC_ORIG_FETCH__ === undefined) {
  g.__OC_ORIG_FETCH__ = g.fetch;
}
const originalFetch = g.__OC_ORIG_FETCH__;

function installJsdomScrollShims(): void {
  // jsdom declares these methods but reports a noisy not-implemented error.
  // A configurable no-op is deliberately used so individual tests can still
  // spy on or replace them to assert real scroll semantics.
  const testWindow = (globalThis as { window?: Window }).window;
  if (testWindow) {
    for (const method of ["scrollBy", "scrollTo"] as const) {
      Object.defineProperty(testWindow, method, {
        configurable: true,
        writable: true,
        value: () => undefined,
      });
    }
  }
}
installJsdomScrollShims();
// Some tests use vi.restoreAllMocks(), which can restore jsdom's noisy native
// methods. Reapply only our test-environment shims after each completed test.
afterEach(installJsdomScrollShims);

afterAll(() => {
  // Drop any `globalThis.chrome` left behind by a test file that installed it
  // (with or without a broken `storage.session` stub) so the next file's
  // `isExtensionWithSession()` detection starts from a clean slate.
  if (typeof (globalThis as { chrome?: unknown }).chrome !== "undefined") {
    delete (globalThis as { chrome?: unknown }).chrome;
  }

  // Clear any DOM nodes left in the shared jsdom document so the ax-tree /
  // DOM-walking tests start from an empty page rather than inheriting another
  // file's leftover elements.
  if (typeof document !== "undefined" && document.body) {
    document.body.innerHTML = "";
  }

  // Reset `localStorage` between files. Many tests seed secrets / provider
  // config / cached data in localStorage; without this reset a value written by
  // one file leaks into the next and corrupts otherwise-correct tests (e.g.
  // secret redaction, which reads its secret set from localStorage).
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.clear();
    } catch {
      /* ignore — some environments make localStorage throw when cleared */
    }
  }

  // Restore the ambient `fetch` (see note above) so a leaked mock can't break
  // later files that depend on the real implementation.
  if (originalFetch !== undefined) {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  } else if (typeof (globalThis as { fetch?: unknown }).fetch !== "undefined") {
    delete (globalThis as { fetch?: unknown }).fetch;
  }
});
