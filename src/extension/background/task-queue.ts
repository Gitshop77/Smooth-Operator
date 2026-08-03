/**
 * background/task-queue.ts — scheduled-task alarm handling + run-completion
 * notifications.
 *
 * `handleScheduledTaskFire` is invoked by the alarm listener in `index.ts`
 * when a scheduled-task alarm fires; it looks up the stored task and starts a
 * run with its prompt. `fireNotifications` is invoked at the end of every run
 * (`agent-bridge.ts`'s `finally` block) to fire a Chrome notification + POST
 * to a webhook (both opt-in via Settings).
 */

import { getScheduledTask } from "@/lib/agent/scheduled-tasks";
import { resolveAndValidateWebhookUrl } from "@/lib/agent/llm/route/ssrf";
import { redactSecrets } from "@/lib/agent/secrets";
import { getRunState, requestKeepAwake, safeLog } from "./state-store";
import { DEFAULT_MAX_STEPS, DEFAULT_MODE, isRunStarting, setRunStarting } from "./agent-bridge";
import { KNOWN_MODES } from "./message-types";

/** Truncate a string for display, adding an ellipsis only when actually truncated. */
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Handle a scheduled-task alarm fire. Looks up the stored task and
 * starts a run with its prompt. Skips if the task was deleted or disabled,
 * or if a run is already active.
 */
export async function handleScheduledTaskFire(taskId: string): Promise<void> {
  try {
    const task = await getScheduledTask(taskId);
    if (!task || !task.enabled) return; // deleted or disabled — skip
 // Don't start if a run is already active.
    const existing = await getRunState();
    if (existing?.active) {
      console.warn("[scheduled-tasks] skipping fire — a run is already active");
      return;
    }
 // acquire the synchronous `runStarting` guard BEFORE calling
 // `startRun`. Without this, a scheduled-task alarm fire racing a manual
 // RUN click within ~50ms could both pass the `existing?.active` check
 // (the storage read is async) and both call `startRun`, starting two
 // concurrent loops. The RUN handler in message-routing.ts uses this
 // same flag — so whichever caller sets it first wins, the other bails.
    if (isRunStarting()) {
      console.warn(
        "[scheduled-tasks] skipping fire — runStarting guard already set (a manual RUN may be starting)",
      );
      return;
    }
    setRunStarting(true);
 // re-acquire the system keep-awake lock right before starting the
 // run. The lock was acquired when the alarm was armed, but the OS may
 // have suspended Chrome between arming and firing (especially for long
 // daily/weekly schedules). Re-requesting here is idempotent and ensures
 // the system stays awake for the duration of the run. `requestKeepAwake`
 // internally checks that at least one enabled task exists (this one) —
 // so it's a no-op if all tasks were disabled between arming + firing.
    await requestKeepAwake();
 // Update lastRunAt + persist (reuse the object already in hand).
    const { saveScheduledTask } = await import("@/lib/agent/scheduled-tasks");
    task.lastRunAt = Date.now();
    await saveScheduledTask(task);
 // Open the side panel + start the run. chrome.sidePanel.open requires a
 // user gesture, which alarm callbacks don't have — so it will throw. Fall
 // back to a notification + badge so the user knows a scheduled task fired;
 // the panel opens on the next action-click (which IS a user gesture).
    try {
      await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    } catch {
      void chrome.action.setBadgeText({ text: "▶" });
      void chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
      void chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon.png",
        title: "Open Cowork — Scheduled Task",
        message: `Starting: ${clip(await redactSecrets(task.task))}\nClick the extension icon to view.`,
        priority: 2,
      }, () => { /* notifications API may not be available */ });
    }
  // Dynamic import breaks the circular dep with agent-bridge.ts (which calls
  // fireNotifications from its `finally` block).
    const { startRun } = await import("./agent-bridge");
  // Validate the stored mode against the known enum before it reaches
  // startRun: a corrupted/stale task row must not feed an unvalidated string
  // into the loop (or the fallback path in agent-bridge logs raw values).
    const mode = task.mode && KNOWN_MODES.has(task.mode) ? task.mode : DEFAULT_MODE;
    await startRun({ task: task.task, maxSteps: DEFAULT_MAX_STEPS, mode, isScheduledTaskRun: true });
  } catch (e) {
 // Route through safeLog so any secret-shaped values embedded in the error
 // (task text, webhook URLs, run-derived strings) are redacted first — the
 // same discipline used by the rest of background/.
    void safeLog(
      "error",
      "[scheduled-tasks] failed to handle alarm fire:",
      e,
    );
 // release the synchronous RUN-guard flag on failure. The flag
 // was set above (`setRunStarting(true)`) BEFORE `startRun`
 // was invoked. If anything between there and the orchestrator's own
 // `finally` throws (e.g. `requestKeepAwake` rejects, `chrome.sidePanel.open`
 // throws, or `startRun` itself throws before reaching its own try/finally),
 // the flag sticks `true` and every subsequent RUN message — manual OR
 // scheduled — is rejected with "already starting" until the SW restarts.
 // Same anti-pattern as the manual-RUN handler (which the agent-bridge fix
 // already resolved for that path).
    setRunStarting(false);
  }
}

// Notification + Webhook on run completion

/**
 * Fire a Chrome notification and/or webhook when a run finishes.
 * Reads the user's notification settings from chrome.storage.local.
 */
export async function fireNotifications(task: string, success?: boolean): Promise<void> {
  try {
    const res = await chrome.storage.local.get([
      "notifyOnCompletion", "notifyOnError", "notifyOnTakeover", "webhookUrl",
    ]);
    const notify = res.notifyOnCompletion as boolean;
    const notifyOnError = res.notifyOnError as boolean;
    // notifyOnTakeover is wired in Options UI but requires takeover-event
    // threading through the notification system — reserved for future work.
    void (res.notifyOnTakeover as boolean);
    const webhookUrl = res.webhookUrl as string;

    if (notify || (notifyOnError && !success)) {
      // Redact before clip: task prompts may contain pasted secret-shaped
      // values, and the message lands in the notification shade (visible in
      // screenshots / screen recordings). Same discipline as the webhook path.
      const message = `Task: ${clip(await redactSecrets(task))}`;
      void chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon.png",
        title: success ? "Open Cowork — Run Succeeded" : "Open Cowork — Run Finished",
        message,
        priority: 2,
      }, () => { /* non-fatal */ });
    }

    if (webhookUrl) {
 // Only POST to an absolute http(s) URL that also passes the webhook
 // SSRF guard. `resolveAndValidateWebhookUrl` rejects relative/malformed
 // values, non-http(s) schemes (`javascript:`/`data:`/`file:`), and internal
 // hosts — cloud-metadata / link-local (`169.254.0.0/16`, `fe80:/10`),
 // unspecified `0.0.0.0/8`, CGNAT `100.64.0.0/10`, and RFC1918/ULA private
 // ranges — and additionally resolves the hostname (when DNS is available) to
 // catch a public hostname that DNS-rebinds to an internal address at fetch
 // time. A webhook is an external notification endpoint (Slack/Discord/custom),
 // so it must never be pointed at internal/metadata hosts to exfiltrate task
 // text or reach internal services. Loopback (`localhost`, `127.0.0.0/8`) is
 // permitted so a self-hosted relay in dev keeps working. Invalid or unsafe
 // URLs are logged + skipped (non-fatal).
      let safeUrl: string | null = null;
      let parsed: URL | null = null;
      const ssrfCheck = await resolveAndValidateWebhookUrl(webhookUrl);
      if (ssrfCheck.ok) {
        try {
          parsed = new URL(webhookUrl);
          safeUrl = parsed.toString();
        } catch {
          parsed = null;
          safeUrl = null;
        }
      }
      if (!safeUrl) {
 // Log only the host, never the full URL: webhook endpoints (Slack,
 // Discord, custom) frequently embed secret bearer tokens in the path
 // or query (e.g. https://hooks.slack.com/services/T000/B000/XXXX).
 // Leaking the raw URL into the service-worker console exposes that
 // credential in shared logs / bug reports / screen recordings.
        let redactedHost = "(unknown host)";
        try {
          redactedHost = (parsed ?? new URL(webhookUrl)).host;
        } catch {
          /* leave default */
        }
        console.warn(
          `[task-queue] skipping webhook — URL must be an absolute http(s) ` +
            `endpoint that is not a loopback/private/cloud-metadata host: ${redactedHost}`,
        );
      } else {
 // Mask any secret shapes embedded in the user's task text before it leaves
 // the extension, so a third-party webhook can't receive leaked credentials.
        const redactedTask = await redactSecrets(task);
        const payload = {
          success: success ?? false,
          text: success ? "Run succeeded." : "Run finished.",
          task: redactedTask,
          timestamp: Date.now(),
        };
 // Bound the request with a 5s timeout so a slow/hanging endpoint does
 // not retain a connection inside the MV3 service worker indefinitely.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        fetch(safeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
 // Do NOT follow redirects: validateWebhookUrl only vets the initial
 // URL, so a 30x Location could send this POST to an internal host the
 // SSRF guard blocks. Treat any redirect as a delivery failure.
          redirect: "manual",
        })
          .catch(() => { /* non-fatal */ })
          .finally(() => clearTimeout(timer));
      }
    }
  } catch {
 // Notification settings not available — non-fatal.
  }
}
