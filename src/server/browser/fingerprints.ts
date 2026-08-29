/**
 * Explicit browser dimensions used for page/layout coherence.
 *
 * This module intentionally does not generate replacement user agents,
 * platform claims, hardware values, languages, or client hints. Chromium's
 * native identity is the only trustworthy identity for a connected browser.
 */

export type StealthProfile = "balanced" | "max";

export interface FingerprintProfile {
  viewport: { width: number; height: number };
}

export interface BuildOptions {
  /** Retained as a compatibility label; it does not change browser identity. */
  profile?: StealthProfile;
  viewport?: { width: number; height: number };
}

const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;

export function buildFingerprintProfile(options: BuildOptions = {}): FingerprintProfile {
  return { viewport: normalizeViewport(options.viewport) };
}

function normalizeViewport(viewport: { width: number; height: number } | undefined): { width: number; height: number } {
  if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0) {
    return { width: Math.floor(viewport.width), height: Math.floor(viewport.height) };
  }
  return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
}
