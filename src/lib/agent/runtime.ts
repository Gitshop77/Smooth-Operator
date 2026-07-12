/**
 * Agent runtime environment detection.
 *
 * `src/lib/agent` is meant to be a reusable, platform-independent agent
 * engine. These helpers are the shared way modules detect whether the Chrome
 * extension runtime (`chrome.*`) is available before touching it, so the
 * detection logic lives in one place rather than being re-derived per module.
 */

export function isExtensionWithLocal(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

export function isExtensionWithSession(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.session;
}

export function isExtensionWithAlarms(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.alarms &&
    !!chrome.storage?.local
  );
}
