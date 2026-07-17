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

import { afterAll } from "vitest";

// Capture the ambient `fetch` once (per test file) so we can restore it after
// the file runs. Some test files install a `globalThis.fetch` mock; if they
// don't fully clean it up, the mock leaks into later files and breaks otherwise
// correct tests (e.g. the per-IP /chat rate-limit integration test, which makes
// real `fetch()` calls against its own server).
const originalFetch = (globalThis as { fetch?: unknown }).fetch;

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
