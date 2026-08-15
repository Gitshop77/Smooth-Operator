/**
 * Structured image attachment — a screenshot attached to a user message
 * as a typed part instead of an interpolated `<screenshot>` text marker.
 *
 * The base64 lives ONLY in this structured part: protocol adapters emit it as
 * a provider-native image block without any regex scan, so a forged
 * `<screenshot>` marker in untrusted page text can never be promoted into an
 * image block. Legacy string content with markers still flows through
 * `extractScreenshots` (shared-image.ts) as defense-in-depth.
 */

export interface ImagePartV1 {
  type: "image";
  /** Full data URL (`data:image/png;base64,...`) as captured. */
  dataUrl: string;
  /** MIME type of the image payload (e.g. `image/png`). */
  mime: string;
  /** Char count of the base64 payload — `dataUrl.length` at construction.
   * Budget asserts consume it to subtract the base64 from the text estimate
   * without allocating a copy of the payload. */
  chars: number;
}

export function isImagePartV1(x: unknown): x is ImagePartV1 {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "image" &&
    typeof (x as { dataUrl?: unknown }).dataUrl === "string" &&
    typeof (x as { mime?: unknown }).mime === "string" &&
    typeof (x as { chars?: unknown }).chars === "number"
  );
}

/** Derive the MIME type from a captured data URL, defaulting to `image/png`. */
export function mimeFromDataUrl(dataUrl: string): string {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(dataUrl);
  return match?.[1] ?? "image/png";
}