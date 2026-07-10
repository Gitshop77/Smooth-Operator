/**
 * Runtime environment detection — shared across the agent library.
 *
 * Several modules need to know whether they're running in a Chrome extension
 * context (with `chrome.storage` / `chrome.alarms` available) vs. a plain
 * browser/Node context (in-page demo, tests). Previously each module had its
 * own copy of the check; this file is the single source of truth.
 *
 * Three variants exist because different modules need different chrome APIs:
 *   - isExtensionWithLocal(): chrome.storage.local (most modules)
 *   - isExtensionWithSession(): chrome.storage.session (secrets.ts)
 *   - isExtensionWithAlarms(): chrome.alarms + chrome.storage.local (scheduled-tasks.ts)
 */

/** True when running in an extension context with chrome.storage.local available. */
export function isExtensionWithLocal(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

/** True when running in an extension context with chrome.storage.session available. */
export function isExtensionWithSession(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.session;
}

/** True when running in an extension context with chrome.alarms + chrome.storage.local available. */
export function isExtensionWithAlarms(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.alarms &&
    !!chrome.storage?.local
  );
}
