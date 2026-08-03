/**
 * Re-export shim — the canonical popup-handler implementation now lives in
 * `./navigation/popup-handler`. This file preserves the legacy
 * `@/lib/agent/dom/popup-handler` import path used by `extension/content.ts`,
 * the executor handlers (`alert.ts`), and `tests/modules-helpers.test.ts`.
 *
 * All historically-exported symbols are re-exported here:
 * - `installPopupHandler`, `getPendingAlertText`,
 * `getPendingAlertKind`, `acceptAlert`, `dismissAlert`, `sendAlertText`,
 * `stagePromptText`, `redactDialogText`
 *
 * The popup-handler lives in `navigation/` because it's a navigation-/blocking-
 * dialog concern. The `alert_*` action handlers (`tools/handlers/alert.ts`)
 * dynamic-import it to inspect/dismiss/send text for pending dialogs, and
 * `extension/content.ts` installs the watchdog on content-script injection.
 *
 * New code should import from `@/lib/agent/dom/navigation/popup-handler`
 *
 */
export {
  installPopupHandler,
  getPendingAlertText,
  getPendingAlertKind,
  acceptAlert,
  dismissAlert,
  sendAlertText,
  stagePromptText,
  redactDialogText,
} from "./navigation/popup-handler";
