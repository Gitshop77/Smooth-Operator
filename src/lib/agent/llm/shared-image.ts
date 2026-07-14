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

/** Validate a base64 image payload before forwarding it to the API. */
export function isValidBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
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

/**
 * Provenance check for `<screenshot>` markers. Markers can be injected into
 * scraped page text or tool output by an untrusted source; treating any such
 * marker as a genuine image would let injected content smuggle attacker-chosen
 * images (or arbitrary bytes) to the model. Requiring the base64 payload's
 * magic bytes to match the declared media type rejects markers whose contents
 * are not a well-formed image of that type.
 */
export function hasImageProvenance(b64: string, mediaType: string): boolean {
  const prefixes = IMAGE_SIGNATURES[mediaType];
  if (!prefixes) return false;
  return prefixes.some((p) => b64.startsWith(p));
}
