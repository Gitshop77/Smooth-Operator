/**
 * Agent runtime environment detection.
 *
 * `src/lib/agent` is meant to be a reusable, platform-independent agent
 * engine. These helpers are the shared way modules detect whether the Chrome
 * extension runtime (`chrome.*`) is available before touching it, so the
 * detection logic lives in one place rather than being re-derived per module.
 */

function hasChromeApi(path: "storage.local" | "storage.session" | "alarms"): boolean {
  if (typeof chrome === "undefined") return false;
  switch (path) {
    case "storage.local": return !!chrome.storage?.local;
    case "storage.session": return !!chrome.storage?.session;
    case "alarms": return !!chrome.alarms;
  }
}

export function isExtensionWithLocal(): boolean {
  return hasChromeApi("storage.local");
}

export function isExtensionWithSession(): boolean {
  return hasChromeApi("storage.session");
}

export function isExtensionWithAlarms(): boolean {
  return hasChromeApi("alarms") && hasChromeApi("storage.local");
}
