/**
 * sidepanel/glyphs.ts — one consistent lucide-style inline-SVG glyph set.
 *
 * Replaces the previous emoji/unicode soup (🧠 👁 🖱 ▸ ✓ ⚠ $) used in the
 * activity log + status row with crisp, OS-consistent SVG icons that inherit
 * `currentColor` (so the existing log-row semantic color classes keep working).
 *
 * This module is a leaf — it imports nothing from the sibling sidepanel
 * modules — so it can be safely imported by log-renderer, lifecycle, etc.
 * without creating a circular dependency.
 */

export type GlyphName =
  | "play"
  | "compass"
  | "chevron-right"
  | "eye"
  | "sparkles"
  | "mouse-pointer"
  | "check"
  | "x"
  | "alert-triangle"
  | "dollar-sign"
  | "info"
  | "refresh-cw"
  | "pause"
  | "hand"
  | "check-circle"
  | "circle"
  | "loader";

/** Inner SVG markup for each glyph (lucide-compatible 24×24 paths). */
const PATHS: Record<GlyphName, string> = {
  play: `<polygon points="6 4 20 12 6 20"/>`,
  compass: `<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>`,
  "chevron-right": `<polyline points="9 18 15 12 9 6"/>`,
  eye: `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`,
  sparkles: `<path d="M9.94 14.66 9 12l-.94 2.66L5.4 15.6l2.66.94L9 19.2l.94-2.66 2.66-.94z"/><path d="M18 3l.94 2.66L21.6 6.6l-2.66.94L18 10.2l-.94-2.66L14.4 6.6l2.66-.94z"/>`,
  "mouse-pointer": `<path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  x: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  "alert-triangle": `<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  "dollar-sign": `<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
  info: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`,
  "refresh-cw": `<polyline points="21 2 21 7 16 7"/><polyline points="3 22 3 17 8 17"/><path d="M21 7a9 9 0 0 0-15-3.7L3 9"/><path d="M3 17a9 9 0 0 0 15 3.7l3-3.3"/>`,
  pause: `<line x1="10" y1="4" x2="10" y2="20"/><line x1="14" y1="4" x2="14" y2="20"/>`,
  hand: `<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-7.6-5.5"/>`,
  "check-circle": `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
  circle: `<circle cx="12" cy="12" r="10"/>`,
  loader: `<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>`,
};

/**
 * Return an inline-SVG string for the named glyph.
 *
 * @param name  Glyph identifier (see {@link GlyphName}).
 * @param size  Square pixel size (default 14 — fits the log-row `.ic` column).
 */
export function glyph(name: GlyphName, size = 14): string {
  return (
    `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  );
}
