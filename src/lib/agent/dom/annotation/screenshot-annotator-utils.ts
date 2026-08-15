import type { CompatibleCanvas } from "./canvas-utils";

/**
 * Test whether a string is a well-formed CSS hex color: `#rgb`, `#rgba`,
 * `#rrggbb`, or `#rrggbbaa` (3/4/6/8 hex digits).
 */
export function isHexColor(c: string): boolean {
  return /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c);
}

/**
 * Validate a CSS hex color string. Canvas silently ignores an invalid
 * `strokeStyle`/`fillStyle`, so reject anything that isn't well-formed
 * and fall back to `fallback`.
 */
export function sanitizeColor(c: string | undefined, fallback: string): string {
  return typeof c === "string" && isHexColor(c.trim()) ? c.trim() : fallback;
}

/** WCAG relative luminance (0 = black, 1 = white) of a `#rgb`/`#rrggbb` hex color. */
function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const expanded =
    c.length === 3 || c.length === 4
      ? c
          .slice(0, 3)
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : c.slice(0, 6);
  const channel = (i: number): number => {
    const v = parseInt(expanded.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Pick `#000`/`#fff` label text for best contrast against a background color. */
export function pickReadableTextColor(bg: string): string {
  return relativeLuminance(bg) > 0.5 ? "#000000" : "#ffffff";
}

/** Convert a canvas back to a JPEG data URL. `quality` is the JPEG quality
 * (0–1); callers that re-encode an already-captured screenshot should pass the
 * original capture quality so round-tripping doesn't silently degrade it.
 * `annotateScreenshot` forwards `options.quality` — the screenshot policy's
 * 0–100 setting divided by 100 at the call site (see `resolveScreenshotPolicy`
 * in the background) — so annotation re-encodes at the SAME quality the
 * capture used instead of the fixed 0.85 default. */
export async function canvasToDataUrl(
  canvas: CompatibleCanvas,
  fallback: string,
  quality = 0.85,
): Promise<string> {
  const oc = canvas as unknown as {
    convertToBlob?: (opts: { type: string; quality?: number }) => Promise<Blob>;
  };
  if (typeof oc.convertToBlob === "function") {
    try {
      const blob = await oc.convertToBlob({ type: "image/jpeg", quality });
      return await blobToDataUrl(blob);
    } catch {
      return fallback;
    }
  }
  const html = canvas as unknown as { toDataURL?: (type: string, quality?: number) => string };
  if (typeof html.toDataURL === "function") {
    try {
      return html.toDataURL("image/jpeg", quality);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** Convert a `Blob` to a `data:` URL via `FileReader`. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const FR = (globalThis as { FileReader?: typeof FileReader }).FileReader;
    if (!FR) {
      reject(new Error("FileReader unavailable"));
      return;
    }
    const reader = new FR();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}
