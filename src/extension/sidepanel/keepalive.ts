/**
 * sidepanel/keepalive.ts — port-based service-worker keepalive with backoff
 * reset on observed traffic.
 *
 * The exponential backoff must not climb to 30s on a healthy worker: any
 * successful SW round-trip (AGENT_EVENT received, STATUS/RUN/STOP resolved)
 * resets the delay to the 1000ms baseline so the port keepalive stays
 * authoritative instead of stalling on a stale high backoff.
 */

let keepaliveDelay = 1000;
const KEEPALIVE_MAX_DELAY = 30_000;
/** Chrome 114+ no longer treats merely opening a long-lived port as activity;
 * traffic on the port resets the service-worker idle timer. Stay comfortably
 * below the ~30s idle cutoff. */
const KEEPALIVE_PING_MS = 20_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepalivePort: chrome.runtime.Port | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** Reset the reconnect backoff to its baseline (call on observed traffic). */
export function resetKeepaliveBackoff(): void {
  keepaliveDelay = 1000;
}

function connectKeepalivePort(): void {
  if (keepalivePort) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    const port = chrome.runtime.connect({ name: "keepalive" });
    keepalivePort = port;
    keepaliveDelay = 1000;
    // Opening a port alone is insufficient on current Chromium. Send an
    // immediate heartbeat, then real port traffic every 20s.
    port.postMessage({ type: "KEEPALIVE_PING" });
    pingTimer = setInterval(() => {
      try {
        port.postMessage({ type: "KEEPALIVE_PING" });
      } catch {
        // onDisconnect owns cleanup + reconnect scheduling.
      }
    }, KEEPALIVE_PING_MS);
    port.onDisconnect.addListener(() => {
      if (keepalivePort === port) keepalivePort = null;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      // Back off on disconnect-driven reconnects too — a flapping port
      // should not reconnect every second indefinitely (matches the catch
      // path below).
      keepaliveDelay = Math.min(keepaliveDelay * 2, KEEPALIVE_MAX_DELAY);
      reconnectTimer = setTimeout(connectKeepalivePort, keepaliveDelay);
    });
  } catch {
    reconnectTimer = setTimeout(connectKeepalivePort, keepaliveDelay);
    keepaliveDelay = Math.min(keepaliveDelay * 2, KEEPALIVE_MAX_DELAY);
  }
}

export function startKeepalivePort(): void {
  connectKeepalivePort();
}
