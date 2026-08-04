/**
 * Curated homoglyph / confusable folding. NFKC does NOT canonicalize
 * letter-like symbols (Cyrillic, Greek, dotless-i) to ASCII, so an attacker can
 * spell injection keywords with lookalike codepoints that survive `normalize()`
 * verbatim into the prompt (e.g. `\u0131gnore` from U+0131, `\u03b5` U+03B5, `\u043e` U+043E).
 * We fold a curated set of ASCII-confusable letters to their ASCII counterparts
 * BEFORE the injection patterns run, closing the homoglyph-injection channel for
 * both `sanitizeUntrusted` and `scanForInjection`. Only codepoints that are
 * visually near-indistinguishable from an ASCII a–z / A–Z letter are folded;
 * this is a deliberate, narrow defense-in-depth map (not a full transliteration)
 * and has zero impact on ReDoS / SSRF / secret-redaction / provenance /
 * constant-time / AU-3 guards.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Latin dotless-i / dotted-I
  "\u0131": "i", "\u0130": "I",
  // Cyrillic lookalikes
  "\u0430": "a", "\u0410": "A",
  "\u0435": "e", "\u0415": "E",
  "\u043e": "o", "\u041e": "O",
  "\u0441": "c", "\u0421": "C",
  "\u0443": "y", "\u0423": "Y",
  "\u0445": "x", "\u0425": "X",
  "\u0440": "p", "\u0420": "P",
  "\u0456": "i", "\u0406": "I",
  "\u0455": "s", "\u0405": "S",
  "\u0432": "v", "\u0412": "V",
  "\u043d": "h", "\u041d": "H",
  "\u043c": "m", "\u041c": "M",
  "\u0442": "t", "\u0422": "T",
  "\u043f": "p", "\u041f": "P",
  "\u0433": "r", "\u0413": "R",
  // Greek lookalikes
  "\u03b1": "a", "\u0391": "A",
  "\u03b2": "b", "\u0392": "B",
  "\u03b5": "e", "\u0395": "E",
  "\u03bf": "o", "\u039f": "O",
  "\u03c1": "p", "\u03a1": "P",
  "\u03c5": "y", "\u03a5": "Y",
  "\u03c7": "x", "\u03a7": "X",
  "\u03ba": "k", "\u039a": "K",
  "\u03bd": "v", "\u039d": "N",
  "\u03bc": "u", "\u039c": "M",
  "\u03b9": "i", "\u0399": "I",
  "\u03c4": "t", "\u03a4": "T",
  "\u03b7": "n", "\u0397": "N",
  "\u03c3": "s", "\u03a3": "S",
  "\u03c2": "s",
  "\u03b3": "g", "\u0393": "G",
  "\u03b4": "d", "\u0394": "D",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPH_MAP).join("")}]`, "gu");

/**
 * Fold ASCII-confusable homoglyphs (Cyrillic/Greek/dotless-i lookalikes) to
 * their ASCII counterparts.
 *
 * APPLIED TO EVERY TEXT THAT ENTERS THE INJECTION PATH — including
 * `sanitizeUntrusted` / `neutralizePromptTags`, which ARE the main raw
 * page-text path into the LLM prompt. The fold therefore has a REAL fidelity
 * cost: legitimate non-English text containing a mapped codepoint is
 * corrupted on its way into the prompt (e.g. Cyrillic "сора" → "copa"). That
 * trade is deliberate — the same lookalike codepoints are the homoglyph
 * injection channel — but it is broader collateral than "scoped to
 * scanning" might suggest. The one path that is NOT folded is {@link normalize}
 * (exact page-text matching, where corrupting non-English text would break
 * match lookups the agent relies on). Only near-indistinguishable
 * ASCII-confusable letters are mapped; the set is curated and narrow, so
 * only text containing those specific codepoints is affected.
 */
export function foldHomoglyphs(text: string): string {
  return text.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
}
