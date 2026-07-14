/**
 * Re-export shim — the canonical popup-handler implementation now lives in
 * `./navigation/popup-handler`. This file preserves the legacy
 * `@/lib/agent/dom/popup-handler` import path used by `extension/content.ts`,
 * the executor handlers (`alert.ts`), and `tests/modules-helpers.test.ts`.
 *
 * All historically-exported symbols are re-exported here:
 * - `installPopupHandler`, `getPendingAlertText`, `getPendingAlertTextRedacted`,
 * `getPendingAlertKind`, `acceptAlert`, `dismissAlert`, `sendAlertText`,
 * `stagePromptText`, `redactDialogText`, `DialogKind` (type)
 *
 * The popup-handler lives in `navigation/` because it's a navigation-/blocking-
 * dialog concern — it's referenced from `navigation/waiter.ts`'s
 * `contentScriptWaitContext.alertPresent()` (which dynamic-imports
 * `./popup-handler` to check for pending dialogs). Co-locating them in the
 * same subdir keeps that cross-reference a sibling import.
 *
 * New code should import from `@/lib/agent/dom/navigation/popup-handler`
 *
 */
export {
  installPopupHandler,
  getPendingAlertText,
  getPendingAlertTextRedacted,
  getPendingAlertKind,
  acceptAlert,
  dismissAlert,
  sendAlertText,
  stagePromptText,
  redactDialogText,
  type DialogKind,
} from "./navigation/popup-handler";
