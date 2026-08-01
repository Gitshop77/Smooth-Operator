/** Common English stop-words to filter out of the keyword set. */
const STOP_WORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for",
  "of", "to", "in", "on", "at", "by", "with", "from", "as", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "should", "could", "can", "may",
  "might", "must", "shall", "this", "that", "these", "those", "i", "you",
  "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "hers",
  "ours", "theirs", "all", "any", "some", "no", "not", "nor", "only",
  "own", "same", "so", "than", "too", "very", "just", "now", "up",
  "down", "out", "off", "over", "under", "again", "further", "once",
  "here", "there", "when", "where", "why", "how", "what", "which",
  "who", "whom", "page", "site", "tab", "browser", "agent",
]);

/** Minimum keyword length to keep (filters out 1-char noise). */
const MIN_KEYWORD_LENGTH = 2;

/**
 * Tokenize a free-text prompt into a set of lowercased keywords.
 *
 * Splits on whitespace + punctuation, drops stop-words + 1-char tokens,
 * lowercases everything. Returns a Set for O(1) membership checks.
 */
export function extractKeywords(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/i);
  for (const tok of tokens) {
    if (tok.length < MIN_KEYWORD_LENGTH) continue;
    if (STOP_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Pre-compiled intent-detection patterns (hoisted so they aren't reallocated on every call). */
export const FORM_INTENT_RE = /\b(fill|submit|login|sign in|sign up|register|enter|form|password|email|username|checkout|pay)\b/;
export const NAV_INTENT_RE = /\b(go to|open|navigate|visit|browse|click|link)\b/;
export const SEARCH_INTENT_RE = /\b(search|find|look up|query|filter)\b/;
export const READ_INTENT_RE = /\b(read|summarize|list|what|who|when|where|how many|tell me|give me|show me)\b/;

/** Tag sets for each intent. */
export const INTENT_TAGS: Record<"form" | "nav" | "search" | "read", Set<string>> = {
  form: new Set(["input", "textarea", "select", "button", "label", "option"]),
  nav: new Set(["a", "button"]),
  search: new Set(["input", "button", "a"]),
  read: new Set(["a", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "article", "section"]),
};

/** Collapse runs of CR/LF into a single space for compact element text. */
export function stripNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** HTML-attribute string escape (ampersand / angle brackets / quotes). */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
