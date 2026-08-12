/**
 * WCAG 2.1 relative-luminance / contrast helpers for the token
 * contrast suite (tests/design-tokens.test.ts). Pure functions.
 *
 * Supports `#RGB`/`#RRGGBB` and `rgba(r, g, b, a)` colors; rgba is blended
 * over a base color first (mirroring how `*-subtle` tokens render over the
 * app background).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Parse `#RGB`/`#RRGGBB`/`rgba(r,g,b,a)` into 0..1 channels. */
export function parseCssColor(input: string): Rgb {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgba) {
    return {
      r: clamp01(Number(rgba[1]) / 255),
      g: clamp01(Number(rgba[2]) / 255),
      b: clamp01(Number(rgba[3]) / 255),
      a: rgba[4] === undefined ? 1 : clamp01(Number(rgba[4])),
    };
  }
  throw new Error(`Unsupported CSS color: ${input}`);
}

/** Blend `fg` over `bg` (both 0..1 channels) using the alpha channel. */
export function blendOver(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: clamp01(fg.r * a + bg.r * (1 - a)),
    g: clamp01(fg.g * a + bg.g * (1 - a)),
    b: clamp01(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color: Rgb): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const ra = typeof a === "string" ? parseCssColor(a) : a;
  const rb = typeof b === "string" ? parseCssColor(b) : b;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast against a *solid* background, blending an rgba fg/bg first. */
export function contrastOnSolid(fg: string, bgSolid: string): number {
  const base = parseCssColor(bgSolid);
  const fgRgb = parseCssColor(fg);
  const effective = fgRgb.a < 1 ? blendOver(fgRgb, base) : fgRgb;
  return contrastRatio(effective, base);
}
