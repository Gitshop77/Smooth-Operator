/**
 * content.ts — the Chrome extension content script entry point.
 *
 * Bundled via esbuild from the shared TypeScript core in `src/lib/agent/*`.
 * Injected into the target tab by the background service worker.
 *
 * Handles these message types from the background script:
 * - `PING` — liveness check (used during injection polling)
 * - `EXTRACT_STATE` — collect DOM state + AX-tree (no HTMLElement refs)
 * - `EXECUTE_ACTIONS` — run a sequence of AgentActions on the page
 * - `EXTRACT_HTML` — return the page's outerHTML for the HTML evaluator
 */

import { initElementMap } from "@/lib/agent/dom/ax-tree";
import { installPopupHandler } from "@/lib/agent/dom/popup-handler";
import {
  CONSOLE_CAPTURE_EVENT,
  type ConsoleLogEntry,
} from "@/lib/agent/dom/console-capture";
import {
  log,
  type IncomingMessage,
  type Response,
  handleExtractState,
  handleExecuteActions,
  handleExtractHtml,
  handleGetDomFingerprint,
} from "./content-utils";

/** Entry point. Idempotent — re-injection is a no-op. */
(() => {
  if ((window as unknown as { __openCoworkInjected?: boolean }).__openCoworkInjected) return;
  Object.defineProperty(window, "__openCoworkInjected", { value: true, enumerable: false, configurable: true });

  try {
    initElementMap();
  } catch (e) {
    log("initElementMap failed:", e);
  }
  try {
    installPopupHandler();
  } catch (e) {
    log("installPopupHandler failed:", e);
  }

  // Relay MAIN-world console captures to the SW console-log ring. The
  // CustomEvent crosses from the MAIN world (where console-capture overrides
  // the page's console) into this isolated world. Best-effort — a sleeping SW
  // or a rejected sendMessage must never throw here.
  window.addEventListener(CONSOLE_CAPTURE_EVENT, (e) => {
    const entry = (e as CustomEvent<{ entry?: ConsoleLogEntry }>).detail?.entry;
    if (!entry) return;
    try {
      // `.catch` swallows async rejections (e.g. the SW sleeping between
      // wakes) — the try/catch alone only covers synchronous throws.
      void chrome.runtime.sendMessage({ type: "CONSOLE_LOG_ENTRY", entry }).catch(() => {});
    } catch {
      /* ignore */
    }
  });

  chrome.runtime.onMessage.addListener(
    (msg: IncomingMessage, sender, sendResponse: (r: Response) => void) => {
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return false;
      }
      switch (msg?.type) {
        case "PING": {
          sendResponse({ ok: true });
          return false;
        }

        case "EXTRACT_STATE": {
          handleExtractState(msg, sendResponse);
          return false;
        }

        case "EXECUTE_ACTIONS": {
          return handleExecuteActions(msg, sendResponse);
        }

        case "EXTRACT_HTML": {
          handleExtractHtml(sendResponse);
          return false;
        }

        case "GET_DOM_FINGERPRINT": {
          handleGetDomFingerprint(sendResponse);
          return false;
        }

        default:
          return false;
      }
    }
  );
})();
