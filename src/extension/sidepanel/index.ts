/**
 * sidepanel/index.ts — entry point for the side panel UI logic.
 *
 * Bundled via esbuild to `sidepanel.js`. Sends RUN/STOP messages to the
 * background service worker and renders the stream of AGENT_EVENT messages
 * as chat messages with cost + token tracking.
 */

import { openOptionsLink } from "./elements";

// Import sibling modules for their top-level side effects (onMessage listener
// registration + addEventListener calls). ES module evaluation order ensures
// every listener is wired before any user interaction can fire.
import "./log-renderer";
import "./controls";
import "./takeover";
import "./human-interact";
import "./lifecycle";

// ─── Port-based service-worker keepalive ──────────────────────────────────

let keepaliveDelay = 1000;
const KEEPALIVE_MAX_DELAY = 30_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectKeepalivePort(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    const port = chrome.runtime.connect({ name: "keepalive" });
    keepaliveDelay = 1000;
    port.onDisconnect.addListener(() => {
      reconnectTimer = setTimeout(connectKeepalivePort, keepaliveDelay);
    });
  } catch {
    reconnectTimer = setTimeout(connectKeepalivePort, keepaliveDelay);
    keepaliveDelay = Math.min(keepaliveDelay * 2, KEEPALIVE_MAX_DELAY);
  }
}
connectKeepalivePort();

// ─── Settings link ────────────────────────────────────────────────────────

openOptionsLink?.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});
