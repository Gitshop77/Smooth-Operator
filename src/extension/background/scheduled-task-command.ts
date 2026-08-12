/** Typed Options -> service-worker scheduled-task command authority. */

import {
  deleteScheduledTask,
  exportScheduledTasks,
  listScheduledTasks,
  saveScheduledTask,
  ScheduledTaskRevisionError,
  setScheduledTaskEnabled,
  importScheduledTasks,
} from "@/lib/agent/scheduled-tasks";
import { isValidTaskEntry } from "@/lib/agent/scheduled-tasks-utils";
import type { ScheduledTaskCommandMessage } from "./message-types";
import { isExactOptionsSender } from "./options-sender";

export function isOptionsSender(sender: chrome.runtime.MessageSender): boolean {
  // Exact origin+pathname match (shared with the options-platform command
  // surface) — a `startsWith` comparison would admit `options.html/…` lookalikes.
  return isExactOptionsSender(sender);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Validate and execute one scheduled-task command in the background context.
 * Returning true keeps Chrome's response channel open for the async mutation.
 */
export function handleScheduledTaskCommand(
  msg: ScheduledTaskCommandMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (!isOptionsSender(sender)) {
    sendResponse({ ok: false, error: "unauthorized scheduled-task sender" });
    return false;
  }
  void (async () => {
    try {
      const version = (msg as { version?: unknown }).version;
      if (version !== undefined && version !== 1) {
        throw new Error("unsupported scheduled-task command version");
      }
      const command = msg.command;
      if (!command || typeof command !== "object") {
        throw new Error("invalid scheduled-task command");
      }
      switch (command.kind) {
        case "list":
          break;
        case "save":
          if (!isValidTaskEntry(command.task)) throw new Error("invalid scheduled task");
          if (command.expectedRevision !== null && !isRevision(command.expectedRevision)) {
            throw new Error("invalid scheduled-task revision");
          }
          await saveScheduledTask(command.task, command.expectedRevision);
          break;
        case "set_enabled":
          if (
            typeof command.taskId !== "string" || command.taskId.trim() === "" ||
            typeof command.enabled !== "boolean" || typeof command.expectedEnabled !== "boolean" ||
            !isRevision(command.expectedRevision)
          ) throw new Error("invalid scheduled-task enable command");
          await setScheduledTaskEnabled(
            command.taskId,
            command.enabled,
            command.expectedRevision,
            command.expectedEnabled,
          );
          break;
        case "delete":
          if (
            typeof command.taskId !== "string" || command.taskId.trim() === "" ||
            !isRevision(command.expectedRevision) || !Number.isFinite(command.expectedCreatedAt)
          ) throw new Error("invalid scheduled-task delete command");
          await deleteScheduledTask(
            command.taskId,
            command.expectedRevision,
            command.expectedCreatedAt,
          );
          break;
        case "export": {
          // Redacted read-only export; the response carries the redacted rows.
          const exported = await exportScheduledTasks();
          sendResponse({ ok: true, exported });
          return;
        }
        case "import": {
          if (!Array.isArray(command.tasks)) throw new Error("invalid scheduled-task import payload");
          const result = await importScheduledTasks(command.tasks);
          sendResponse({ ok: true, ...result });
          return;
        }
        default:
          throw new Error("unknown scheduled-task command");
      }
      sendResponse({ ok: true, tasks: await listScheduledTasks() });
    } catch (error) {
      sendResponse({
        ok: false,
        ...(error instanceof ScheduledTaskRevisionError ? { code: error.code } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return true;
}
