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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset the reconnect backoff to its baseline (call on observed traffic). */
export function resetKeepaliveBackoff(): void {
  keepaliveDelay = 1000;
}

function connectKeepalivePort(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    const port = chrome.runtime.connect({ name: "keepalive" });
    keepaliveDelay = 1000;
    port.onDisconnect.addListener(() => {
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