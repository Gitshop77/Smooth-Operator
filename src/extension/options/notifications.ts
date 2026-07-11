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

$("notifyOnCompletion")?.addEventListener("change", (e) =>
  persist(STORAGE_KEYS.notifyOnCompletion, (e.target as HTMLInputElement).checked),
);
$("notifyOnError")?.addEventListener("change", (e) =>
  persist(STORAGE_KEYS.notifyOnError, (e.target as HTMLInputElement).checked),
);
$("notifyOnTakeover")?.addEventListener("change", (e) =>
  persist(STORAGE_KEYS.notifyOnTakeover, (e.target as HTMLInputElement).checked),
);
$("webhookUrl")?.addEventListener("change", (e) => {
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
