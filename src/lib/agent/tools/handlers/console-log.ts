/**
 * Console-log actions — enable / disable / get / clear / getclear the
 * SW-side ring (rate-limit-tracker.ts). The ring lives in the service worker
 * so entries survive tab navigations; the MAIN-world console capture
 * (`@/lib/agent/dom/console-capture`) relays calls there via
 * `CONSOLE_LOG_ENTRY`, and these handlers delegate the verbs via the
 * `CONSOLE_LOG` runtime message. The handlers are thin re-exports of the
 * parameterized ring-log core in `./sw-rpc`.
 */

import { makeRingLogHandler } from "./sw-rpc";

export const handleEnableConsoleLog = makeRingLogHandler({
  messageType: "CONSOLE_LOG",
  noun: "console log",
  actionType: "enable_console_log",
  verb: "enable",
});

export const handleDisableConsoleLog = makeRingLogHandler({
  messageType: "CONSOLE_LOG",
  noun: "console log",
  actionType: "disable_console_log",
  verb: "disable",
});

export const handleGetConsoleLog = makeRingLogHandler({
  messageType: "CONSOLE_LOG",
  noun: "console log",
  actionType: "get_console_log",
  verb: "get",
});

export const handleClearConsoleLog = makeRingLogHandler({
  messageType: "CONSOLE_LOG",
  noun: "console log",
  actionType: "clear_console_log",
  verb: "clear",
});

export const handleGetclearConsoleLog = makeRingLogHandler({
  messageType: "CONSOLE_LOG",
  noun: "console log",
  actionType: "getclear_console_log",
  verb: "getclear",
});
