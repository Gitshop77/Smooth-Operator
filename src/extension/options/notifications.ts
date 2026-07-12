/**
 * options/notifications.ts — notification rules tab.
 *
 * Toggles for: on run complete, on run error, on takeover; plus a webhook URL
 * (POSTed the run result on completion). All persist to chrome.storage.local on
 * change and flash the shared "Saved" cue.
 */

import { $ } from "@/extension/shared";
import { STORAGE_KEYS, showSaved, isHttpUrl } from "./settings-sync";
import { alertModal } from "./modal";

// `isHttpUrl` is imported from `settings-sync` (single shared definition) rather
// than duplicated here, so validation stays consistent across the options pages.

/** Load the persisted notification settings into the form. */
export async function loadNotifications(): Promise<void> {
  const res = await chrome.storage.local.get([
    STORAGE_KEYS.notifyOnCompletion,
    STORAGE_KEYS.notifyOnError,
    STORAGE_KEYS.notifyOnTakeover,
    STORAGE_KEYS.webhookUrl,
  ]);
  // Mirror the careful error handling in settings-sync.ts: a transient storage
  // failure (quota, disabled storage) must degrade gracefully rather than throw
  // an unhandled rejection. Without this guard `res` can be `undefined` on
  // failure and `res.notifyOnCompletion` would throw a TypeError.
  if (chrome.runtime.lastError) {
    console.warn("[options] failed to load notification settings:", chrome.runtime.lastError);
    return;
  }
  if (!res) return;
  ($("notifyOnCompletion") as HTMLInputElement).checked = (res.notifyOnCompletion as boolean) || false;
  ($("notifyOnError") as HTMLInputElement).checked = (res.notifyOnError as boolean) || false;
  ($("notifyOnTakeover") as HTMLInputElement).checked = (res.notifyOnTakeover as boolean) || false;
  ($("webhookUrl") as HTMLInputElement).value = (res.webhookUrl as string) || "";
}

function persist(key: string, value: string | boolean): void {
  // Use the `set` callback so a failed write (quota, disabled storage, etc.)
  // is not silently reported as success. Mirrors settings-sync.saveSettings,
  // which checks `chrome.runtime.lastError` and surfaces a modal on failure.
  chrome.storage.local.set({ [key]: value }, () => {
    if (chrome.runtime.lastError) {
      console.warn(`[options] failed to save ${key}:`, chrome.runtime.lastError);
      void alertModal({
        title: "Save failed",
        message: `Failed to save setting: ${chrome.runtime.lastError?.message || "unknown error"}`,
      });
      return;
    }
    showSaved();
  });
}

// NOTE: `$` from @/extension/shared *throws* on a missing element, so the `?.`
// after it was dead code that implied "skip if absent" while actually crashing
// the Options page at load. Use `document.getElementById(...)?.` here instead so
// the optional chaining is meaningful: a missing element is skipped gracefully
// rather than throwing an uncaught error. (loadNotifications still uses `$`
// because those required inputs must exist for the tab to function.)
document.getElementById("notifyOnCompletion")?.addEventListener("change", (e) =>
  persist(STORAGE_KEYS.notifyOnCompletion, (e.target as HTMLInputElement).checked),
);
document.getElementById("notifyOnError")?.addEventListener("change", (e) =>
  persist(STORAGE_KEYS.notifyOnError, (e.target as HTMLInputElement).checked),
);
document.getElementById("notifyOnTakeover")?.addEventListener("change", (e) =>
  persist(STORAGE_KEYS.notifyOnTakeover, (e.target as HTMLInputElement).checked),
);
document.getElementById("webhookUrl")?.addEventListener("change", (e) => {
  // Defense-in-depth: the consumer (`fireNotifications`) already rejects
  // non-http(s)/malformed URLs at POST time, but validate at the input too so
  // a stored value is always safe regardless of future consumers.
  const value = (e.target as HTMLInputElement).value.trim();
  if (value !== "" && !isHttpUrl(value)) {
    void alertModal({
      title: "Invalid webhook URL",
      message:
        "The webhook URL must be an absolute http(s) URL. It was not saved; the previous value is kept.",
    });
    // Revert the field to the last persisted (valid) value.
    void loadNotifications();
    return;
  }
  persist(STORAGE_KEYS.webhookUrl, value);
});
