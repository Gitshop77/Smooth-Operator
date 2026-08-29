/**
 * Stealth: coherent baseline launch args + init-script source.
 *
 * Pure module — produces strings only. No browser runtime is imported and there
 * are no side effects at import time. `STEALTH_BASELINE_ARGS` is the single
 * source of the supported automation-control flag (appended by
 * `nativeBrowserLaunchArgs` when stealth is enabled); `buildStealthInitScript`
 * returns a single bundled page-JS source string that is injected once per
 * document via `page.evaluateOnNewDocument`. The runtime supplies the optional
 * viewport when configured. No unsupported UA, platform, browser
 * version, language, or client-hint claims are fabricated.
 *
 * Coherence over maximality: every patch is guarded and never throws (a throwing
 * patch is a louder tell). The accepted `balanced`/`max` labels are retained
 * for configuration compatibility, while both currently use this minimal
 * supported patch set.
 */

import type { FingerprintProfile } from "./fingerprints";

/**
 * Stealth baseline flags (append-only, never mutated by callers). Appended by
 * `nativeBrowserLaunchArgs` when stealth is enabled; the runtime builder works
 * on a fresh copy so this shared array stays pristine for the default-args test.
 */
export const STEALTH_BASELINE_ARGS: readonly string[] = [
  "--disable-blink-features=AutomationControlled", // hide navigator.webdriver at the C++ source
];

/**
 * Build the bundled init-script SOURCE (a single string, injected once per
 * document via `page.evaluateOnNewDocument(source)`). The source is self-
 * contained page-JS that runs in the page main world before page scripts and
 * interpolates the explicitly configured viewport.
 */
export function buildStealthInitScript(
  profile: FingerprintProfile,
  options: { max?: boolean; applyViewport?: boolean } = {},
): string {
  const { width, height } = profile.viewport;
  const applyViewport = options.applyViewport === true;

  const head = `
  // ---- shared helpers (ported, minimal) ----
  function makeNativeString(fnName) {
    return 'function ' + fnName + '() { [native code] }';
  }
  function patchToString(target, fnStr) {
    try {
      Object.defineProperty(target, 'toString', {
        configurable: true,
        writable: true,
        value: function toString() { return fnStr; }
      });
    } catch (e) {}
  }
  function stripProxyFromErrors(fn) {
    try {
      return new Proxy(fn, {
        apply: function applyTrap(target, thisArg, args) {
          try { return Reflect.apply(target, thisArg, args); }
          catch (e) { throw e; }
        }
      });
    } catch (e) { return fn; }
  }

  // ---- supported runtime values (only explicit configuration is interpolated) ----
  var APPLY_VIEWPORT = ${String(applyViewport)};
  var VIEWPORT = { width: ${width}, height: ${height} };`;

  const balanced = `
  // 1. navigator.webdriver — belt-and-suspenders (the launch flag is primary).
  try {
    var navProto = Object.getPrototypeOf(navigator);
    if (navProto && Object.prototype.hasOwnProperty.call(navProto, 'webdriver')) {
      delete navProto.webdriver;
    }
  } catch (e) {}

  // 2. navigator.permissions.query — resolve the "impossible combination".
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      var perms = navigator.permissions;
      var originalQuery = perms.query.bind(perms);
      perms.query = function (query) {
        if (query && query.name === 'notifications' &&
            window.location && window.location.protocol !== 'https:') {
          try {
            if (typeof PermissionStatus !== 'undefined') {
              return Promise.resolve(new PermissionStatus({ state: 'denied' }));
            }
          } catch (e) {}
        }
        return originalQuery(query);
      };
    }
  } catch (e) {}

  // 3. toString / Proxy trace hiding — the patched getters hide themselves.
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      var hiddenQuery = stripProxyFromErrors(navigator.permissions.query);
      patchToString(hiddenQuery, makeNativeString('query'));
      navigator.permissions.query = hiddenQuery;
    }
  } catch (e) {}

  // Coherence: screen dimensions track an explicitly configured launch
  // viewport (guarded, best-effort). Without that explicit input, leave the
  // browser's real dimensions untouched.
  try {
    if (APPLY_VIEWPORT && window && typeof window.innerWidth === 'number') {
      Object.defineProperty(window, 'innerWidth', {
        value: VIEWPORT.width, configurable: true, enumerable: false
      });
      Object.defineProperty(window, 'innerHeight', {
        value: VIEWPORT.height, configurable: true, enumerable: false
      });
    }
  } catch (e) {}`;

  return `(function () {\n${head}\n${balanced}\n})();\n`;
}
