/**
 * options/notifications.ts — C18 notifications tab.
 *
 * Two controls: a "notify on completion" checkbox (fires a Chrome
 * notification when a run finishes) and a webhook URL field (POSTs the run
 * result on completion). Both persist to chrome.storage.local on change.
 */

import { $ } from "@/extension/shared";

/** Load the persisted notification settings into the form. */
export async function loadNotifications(): Promise<void> {
  const res = await chrome.storage.local.get(["notifyOnCompletion", "webhookUrl"]);
  ($("notifyOnCompletion") as HTMLInputElement).checked = (res.notifyOnCompletion as boolean) || false;
  ($("webhookUrl") as HTMLInputElement).value = (res.webhookUrl as string) || "";
}

$("notifyOnCompletion")?.addEventListener("change", () => {
  chrome.storage.local.set({ notifyOnCompletion: ($("notifyOnCompletion") as HTMLInputElement).checked });
});
$("webhookUrl")?.addEventListener("change", () => {
  chrome.storage.local.set({ webhookUrl: ($("webhookUrl") as HTMLInputElement).value });
});
