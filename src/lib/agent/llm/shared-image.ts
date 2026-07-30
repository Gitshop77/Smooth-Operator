/**
 * Shared image / provenance helpers used by the LLM protocol adapters
 * (anthropic-messages and gemini). Centralized so the security-critical
 * provenance check stays a single source of truth and can't drift between
 * adapters.
 */

/** Global pattern matching a `<screenshot>data:image/...;base64,...</screenshot>` marker. */
export const SCREENSHOT_PATTERN_G =
  /<screenshot>(data:image\/(png|jpeg|webp);base64,[^<]+)<\/screenshot>/g;

/** Heuristic: is this a Zod schema object (vs. an already-plain JSON Schema)? */
export function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (("safeParse" in value && typeof (value as { safeParse?: unknown }).safeParse === "function") ||
      "_def" in value)
  );
}

/**
 * Max base64 payload length (~20MB decoded). Rejects absurdly large payloads
 * at the boundary to prevent excessive API costs or memory pressure.
 * 20MB = 20 * 1024 * 1024 bytes; base64 ratio is 4/3, so ≈ 28M chars.
 */
const MAX_BASE64_LENGTH = 28_000_000;

/** Validate a base64 image payload before forwarding it to the API. */
export function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length > MAX_BASE64_LENGTH) return false;
  // Require a canonical base64 length (multiple of 4) and trailing-only
  // padding (0–2 '='), never embedded/standalone padding. The looser
  // `*{0,2}` pattern previously accepted wrong lengths and misplaced padding.
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+(?:={1,2})?$/.test(value);
}

/**
 * Base64-encoded magic-byte prefixes for the image formats we accept. A real
 * screenshot produced by the extension always begins with the format's signature
 * bytes, so requiring the declared `media_type` to match the actual payload is a
 * lightweight provenance check.
 */
export const IMAGE_SIGNATURES: Record<string, string[]> = {
  // PNG: 89 50 4E 47 0D 0A 1A 0A -> "iVBORw0KGgo"
  png: ["iVBORw0KGgo"],
  // JPEG: FF D8 FF -> "/9j/"
  jpeg: ["/9j/"],
  // WebP: "RIFF"....."WEBP" -> "UklGR"
  webp: ["UklGR"],
};

/** Provenance check for `<screenshot>` markers. */
export function hasImageProvenance(b64: string, mediaType: string): boolean {
  const prefixes = IMAGE_SIGNATURES[mediaType];
  if (!prefixes) return false;
  return prefixes.some((p) => b64.startsWith(p));
}

/** Result of extracting screenshots from message content. */
export interface ScreenshotExtraction {
  /** Message content with all <screenshot> markers stripped. */
  text: string;
  /** Extracted screenshot data URIs (data:image/...;base64,...). */
  dataUris: string[];
}

/**
 * Extract all `<screenshot>` markers from message content, validating each
 * payload's base64 encoding and provenance. Returns the cleaned text and
 * an array of validated data URIs. Throws if any marker has invalid base64
 * or fails the provenance check.
 */
export function extractScreenshots(content: string): ScreenshotExtraction {
  const matches = Array.from(content.matchAll(SCREENSHOT_PATTERN_G));
  if (matches.length === 0) {
    return { text: content, dataUris: [] };
  }
  const text = content.replace(SCREENSHOT_PATTERN_G, "").trim();
  const dataUris: string[] = [];
  for (const match of matches) {
    const dataUri = match[1];
    const b64 = dataUri.split(",")[1];
    if (!isValidBase64(b64 ?? "")) {
      throw new Error("Invalid base64 screenshot payload in user message");
    }
    if (!hasImageProvenance(b64 ?? "", match[2])) {
      throw new Error("<screenshot> marker failed provenance check: base64 payload does not match its declared image type.");
    }
    dataUris.push(dataUri);
  }
  return { text, dataUris };
}
