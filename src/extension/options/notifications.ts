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

/**
 * Last successfully-persisted (valid) webhook URL. Used as the revert value when
 * the user types an invalid URL: even if the storage re-read in `loadNotifications`
 * fails (quota/disabled), we can still restore the field to a known-good value
 * instead of leaving the rejected URL visible as if it had been accepted.
 */
let lastKnownGoodWebhookUrl = "";

/** Load the persisted notification settings into the form. */
export async function loadNotifications(): Promise<void> {
  let res: Record<string, unknown>;
 // Mirror the careful error handling in settings-sync.ts: a transient storage
 // failure (quota, disabled storage) must degrade gracefully rather than throw
 // an unhandled rejection. With the promise form, `chrome.runtime.lastError`
 // is not a reliable signal — the `await` itself rejects on failure — so we
 // catch the rejection directly.
  try {
    res = await chrome.storage.local.get([
      STORAGE_KEYS.notifyOnCompletion,
      STORAGE_KEYS.notifyOnError,
      STORAGE_KEYS.notifyOnTakeover,
      STORAGE_KEYS.webhookUrl,
    ]);
  } catch (e) {
    console.warn("[options] failed to load notification settings:", e);
    return;
  }
  if (!res) return;
  ($("notifyOnCompletion") as HTMLInputElement).checked = (res.notifyOnCompletion as boolean) || false;
  ($("notifyOnError") as HTMLInputElement).checked = (res.notifyOnError as boolean) || false;
  ($("notifyOnTakeover") as HTMLInputElement).checked = (res.notifyOnTakeover as boolean) || false;
  const webhook = (res.webhookUrl as string) || "";
  ($("webhookUrl") as HTMLInputElement).value = webhook;
 // Record the verified-good value so an invalid edit can be reverted even if a
 // subsequent storage read fails.
  lastKnownGoodWebhookUrl = webhook;
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
const NOTIFICATION_TOGGLES: ReadonlyArray<readonly [string, string]> = [
  ["notifyOnCompletion", STORAGE_KEYS.notifyOnCompletion],
  ["notifyOnError", STORAGE_KEYS.notifyOnError],
  ["notifyOnTakeover", STORAGE_KEYS.notifyOnTakeover],
];
for (const [id, key] of NOTIFICATION_TOGGLES) {
  document.getElementById(id)?.addEventListener("change", (e) =>
    persist(key, (e.target as HTMLInputElement).checked),
  );
}
document.getElementById("webhookUrl")?.addEventListener("change", (e) => {
 // Defense-in-depth: the consumer (`fireNotifications`) already rejects
 // non-http(s)/malformed URLs at POST time, but validate at the input too so
 // a stored value is always safe regardless of future consumers.
  const field = e.target as HTMLInputElement;
  const value = field.value.trim();
  if (value !== "" && !isHttpUrl(value)) {
    void alertModal({
      title: "Invalid webhook URL",
      message:
        "The webhook URL must be an absolute http(s) URL. It was not saved; the previous value is kept.",
    });
    field.setAttribute("aria-invalid", "true");
 // Revert to the last known-good value directly from cache. This is robust
 // even if the storage re-read in `loadNotifications()` were to fail (quota/
 // disabled storage), which would otherwise leave the rejected URL on screen.
    field.value = lastKnownGoodWebhookUrl;
    field.setAttribute("aria-invalid", "false");
    return;
  }
 // Only cache once we know the value is valid (and will be persisted).
  if (value !== "") lastKnownGoodWebhookUrl = value;
  field.setAttribute("aria-invalid", "false");
  persist(STORAGE_KEYS.webhookUrl, value);
});
