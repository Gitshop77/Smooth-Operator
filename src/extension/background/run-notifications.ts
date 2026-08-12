import { redactSecrets } from "@/lib/agent/secrets";
import { deliverWebhook, maskWebhookUrl } from "./webhook-delivery";

/** Truncate a string for display, adding an ellipsis only when truncated. */
export const clipNotificationText = (value: string, max = 80): string =>
  value.length > max ? value.slice(0, max - 1) + "…" : value;

/** Fire the configured Chrome notification and/or webhook after a run. */
export async function fireNotifications(task: string, success?: boolean): Promise<void> {
  try {
    const res = await chrome.storage.local.get([
      "notifyOnCompletion", "notifyOnError", "notifyOnTakeover", "webhookUrl",
    ]);
    const notify = res.notifyOnCompletion as boolean;
    const notifyOnError = res.notifyOnError as boolean;
    // Reserved until takeover events are threaded through this service.
    void (res.notifyOnTakeover as boolean);
    const webhookUrl = res.webhookUrl as string;

    if (notify || (notifyOnError && !success)) {
      const message = `Task: ${clipNotificationText(await redactSecrets(task))}`;
      // Stable id replaces a predecessor's tray entry instead of stacking
      // identical alerts; high-priority notices are auto-dismissed on some
      // platforms, so requireInteraction keeps the completion signal visible.
      void chrome.notifications.create(
        "run-complete",
        {
          type: "basic",
          iconUrl: "icons/icon.png",
          title: success ? "Open Cowork — Run Succeeded" : "Open Cowork — Run Finished",
          message,
          priority: 2,
          requireInteraction: true,
        },
        () => { /* non-fatal */ },
      );
    }

    if (webhookUrl) {
      // Bounded, SSRF-guarded, single-attempt delivery. Failures are non-fatal
      // and logged with the URL MASKED (never the raw endpoint — paths and
      // queries commonly carry credentials). Delivery is FIRE-AND-FORGET: the
      // service worker must return without awaiting the POST (the 5s abort
      // timeout in `deliverWebhook` still bounds the connection lifetime).
      void deliverWebhook(webhookUrl, {
        task,
        success: success ?? false,
        text: success ? "Run succeeded." : "Run finished.",
        timestamp: Date.now(),
      }).then((result) => {
        if (!result.ok) {
          console.warn(
            `[task-queue] webhook not delivered (${result.code}): ${maskWebhookUrl(webhookUrl)}`,
          );
        }
      });
    }
  } catch {
    // Notification settings are optional and failures are non-fatal.
  }
}
