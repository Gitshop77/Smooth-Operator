/**
 * background/options-sender.ts — single authoritative "options page sender"
 * guard shared by every Options→background command surface.
 *
 * The Options page URL is parsed once on first use (module load may precede
 * the chrome.runtime stub in tests / cold SW starts); an exact origin+pathname
 * match is the only acceptable shape (query/hash suffixes are fine — `URL`
 * ignores them — but a differing path like `options.html/evil` is rejected,
 * where a naive `startsWith` would pass it).
 */

let cachedOrigin: string | null | undefined;
let cachedPathname: string | null | undefined;

function optionsUrlParts(): { origin: string | null; pathname: string | null } {
  if (cachedOrigin === undefined) {
    try {
      const parsed = new URL(chrome.runtime.getURL("options.html"));
      cachedOrigin = parsed.origin;
      cachedPathname = parsed.pathname;
    } catch {
      cachedOrigin = null;
      cachedPathname = null;
    }
  }
  return { origin: cachedOrigin ?? null, pathname: cachedPathname ?? null };
}

/** True when `sender` is this extension's Options page (exact origin+path). */
export function isExactOptionsSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  const { origin, pathname } = optionsUrlParts();
  if (origin === null || pathname === null) return false;
  try {
    const actual = new URL(sender.url);
    return actual.origin === origin && actual.pathname === pathname;
  } catch {
    return false;
  }
}
