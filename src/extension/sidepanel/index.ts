/**
 * sidepanel/index.ts — entry point for the side panel UI logic.
 *
 * Bundled via esbuild to `sidepanel.js`. Sends RUN/STOP messages to the
 * background service worker and renders the stream of AGENT_EVENT messages
 * as chat messages with cost + token tracking.
 */

import { openOptionsLink } from "./elements";
import { startKeepalivePort } from "./keepalive";

// Import sibling modules for their top-level side effects (onMessage listener
// registration + addEventListener calls). ES module evaluation order ensures
// every listener is wired before any user interaction can fire.
import "./log-renderer";
import "./controls";
import "./takeover";
import "./human-interact";
import "./lifecycle";
import "./usage-panel";

// ─── Port-based service-worker keepalive ──────────────────────────────────
// The port keeps the MV3 worker alive while the panel is open; `resetKeepaliveBackoff`
// (imported by log-renderer/controls on observed traffic) keeps the reconnect
// delay at its baseline on a healthy worker.
startKeepalivePort();

// ─── Settings link ────────────────────────────────────────────────────────

openOptionsLink?.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
});
