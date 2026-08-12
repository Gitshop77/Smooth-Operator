/**
 * background/history-command.ts — background-owned run-history commands.
 *
 * The Options page never read-modify-writes the whole history list: reads,
 * clears, exports, and imports all go through these typed commands so the
 * background remains the single mutation authority (mutex + monotonic revision
 * counter in `lib/agent/run-history`). Sender-gated to the Options page.
 */

import {
  clearAllRuns,
  getHistoryRevision,
  HistoryRevisionError,
  loadRuns,
  mergeRuns,
} from "@/lib/agent/run-history";
import { redactRunSecrets } from "@/lib/agent/run-history-utils";
import type { HistoryCommandMessage } from "./message-types";
import { isOptionsSender } from "./scheduled-task-command";

/**
 * Validate and execute one history command in the background context.
 * Returning true keeps Chrome's response channel open for the async work.
 */
export function handleHistoryCommand(
  msg: HistoryCommandMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (!isOptionsSender(sender)) {
    sendResponse({ ok: false, error: "unauthorized history sender" });
    return false;
  }
  void (async () => {
    try {
      if (msg?.version !== 1) throw new Error("unsupported history command version");
      const command = msg.command;
      if (!command || typeof command !== "object") {
        throw new Error("invalid history command");
      }
      switch (command.kind) {
        case "list": {
          const [runs, revision] = await Promise.all([loadRuns(), getHistoryRevision()]);
          sendResponse({ ok: true, runs, revision });
          return;
        }
        case "clear":
          await clearAllRuns();
          sendResponse({ ok: true });
          return;
        case "export": {
          // Defense-in-depth: storage already redacts on write, but an export
          // re-redacts every value so a future write-path regression cannot
          // leak through the export boundary.
          const runs = await loadRuns();
          const redacted = await Promise.all(runs.map(redactRunSecrets));
          sendResponse({ ok: true, runs: redacted });
          return;
        }
        case "import": {
          if (!Array.isArray(command.entries) || !Number.isSafeInteger(command.expectedRevision)) {
            throw new Error("invalid history import payload");
          }
          const result = await mergeRuns(command.entries, command.expectedRevision);
          sendResponse({ ok: true, ...result });
          return;
        }
        default:
          throw new Error("unknown history command");
      }
    } catch (error) {
      sendResponse({
        ok: false,
        ...(error instanceof HistoryRevisionError ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true;
}
