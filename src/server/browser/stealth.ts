/**
 * Browser compatibility: explicit viewport coherence only.
 *
 * Pure module — produces strings only. No browser runtime is imported and there
 * are no side effects at import time. `STEALTH_BASELINE_ARGS` is empty;
 * `buildStealthInitScript` returns a small page script that is injected once per
 * document via `page.evaluateOnNewDocument`. The runtime supplies the optional
 * viewport when configured. It deliberately does not hide automation markers,
 * patch browser APIs, or fabricate UA/platform/version/language/client-hint
 * claims.
 *
 * Coherence over maximality: the only supported patch is explicit viewport
 * alignment, and it is guarded so a page cannot make initialization fail.
 * The accepted `balanced`/`max` labels remain for compatibility.
 */

import type { FingerprintProfile } from "./fingerprints";

/**
 * No identity or automation-evasion flags are supported. The constant remains
 * exported for source compatibility with callers that inspect launch options.
 */
export const STEALTH_BASELINE_ARGS: readonly string[] = [
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

  const source = `
  // Only an explicitly configured viewport is applied. Browser identity and
  // native automation signals remain untouched.
  var APPLY_VIEWPORT = ${String(applyViewport)};
  var VIEWPORT = { width: ${width}, height: ${height} };`;

  const viewport = `
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

  return `(function () {\n${source}\n${viewport}\n})();\n`;
}
