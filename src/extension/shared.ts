/**
 * shared.ts — DOM helpers shared by options.ts and sidepanel.ts.
 *
 * Keeping these in one module avoids two divergent copies and lets both pages
 * use the same `$` (throw on missing) + `escapeHtml` semantics. Also hosts
 * the cockpit URL configuration (used by the "Open Cowork Cockpit" button
 * in the side panel and the matching settings field in the options page).
 */

/**
 * Get an element by id, throwing if missing (dev-time safety).
 * Generic param `T` lets callers narrow to e.g. `HTMLInputElement`.
 */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/**
 * Escape user-supplied text for safe interpolation inside `innerHTML`.
 * Replaces the five significant XML characters: & < > " ', plus `/` (so the
 * output can never prematurely close an attribute or inject a path). Escaping
 * `/` is harmless in normal text — it renders identically — but closes a
 * latent cross-context injection hole.
 */
export function escapeHtml(s: unknown): string {
  return String(s).replace(
    /[&<>"'/]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "/": "&#47;",
      })[c]!,
  );
}

// ─── Cockpit URL ──────────────────────────────────────────────────────────
//
// The Cowork Cockpit is a Next.js dashboard that lives outside the
// extension (dev: http://localhost:3000, prod: a deployed URL). The side
// panel's "Open Cowork Cockpit" button opens this URL in a new tab. The
// user can override it in Settings in case their cockpit runs on a
// non-default host/port (e.g. behind a gateway or in a container).

export const DEFAULT_COCKPIT_URL = "http://localhost:3000";
export const COCKPIT_URL_STORAGE_KEY = "coworkCockpitUrl";

/**
 * Read the configured cockpit URL from chrome.storage.local, falling back
 * to DEFAULT_COCKPIT_URL if unset or empty.
 */
export async function getCockpitUrl(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(COCKPIT_URL_STORAGE_KEY);
    const stored = result[COCKPIT_URL_STORAGE_KEY];
    const candidate = typeof stored === "string" && stored.trim() ? stored.trim() : DEFAULT_COCKPIT_URL;
    // Reject non-http(s) schemes (javascript:, data:, blob:, file:, …). A
    // corrupt or attacker-controlled stored value must never be opened in a
    // new tab as an executable scheme — fall back to the safe default.
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return DEFAULT_COCKPIT_URL;
      }
    } catch {
      return DEFAULT_COCKPIT_URL;
    }
    return candidate;
  } catch {
    // chrome.storage may be unavailable in tests / non-extension contexts.
    return DEFAULT_COCKPIT_URL;
  }
}
