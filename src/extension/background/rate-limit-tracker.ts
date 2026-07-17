/**
 * background/rate-limit-tracker.ts — network-authoritative 429/503 signal.
 *
 * The MAIN-world DOM challenge detector in `@/lib/agent/anti-bot` deliberately
 * refuses to derive a "rate-limited" state from page content: the document
 * title, body text, and CSS classes are all attacker-settable, so a hostile
 * page could otherwise force a false rate-limit and stall the agent. The
 * authoritative signal for a genuine throttle is the real HTTP response status,
 * which is only visible at the network layer.
 *
 * This module listens for top-level (main-frame) 429/503 responses per tab via
 * `chrome.webRequest` and records the most recent one so the anti-bot hooks can
 * surface a `rate-limited` challenge kind instead of blindly acting on (and
 * burning steps/LLM calls against) a throttled endpoint.
 */

/** HTTP statuses that represent a network-layer throttle / back-off signal. */
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set<number>([429, 503]);

/** How long a recorded rate-limit stays "fresh" (ms). */
const RATE_LIMIT_TTL_MS = 30_000;

/** tabId → timestamp (ms) of the most recent 429/503 main-frame response. */
const recentByTab = new Map<number, number>();

let registered = false;

/**
 * Register the `chrome.webRequest.onCompleted` listener (idempotent). Records
 * main-frame 429/503 responses per tab; a subsequent successful main-frame load
 * clears any stale record for that tab. No-op when the API is unavailable.
 */
export function registerRateLimitListener(): void {
  if (registered) return;
  if (!chrome.webRequest?.onCompleted) return;
  registered = true;
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      // Only the top-level document matters for "the page the agent acts on".
      if (details.type !== "main_frame") return;
      if (details.tabId < 0) return;
      if (RATE_LIMIT_STATUSES.has(details.statusCode)) {
        recentByTab.set(details.tabId, Date.now());
      } else {
        recentByTab.delete(details.tabId);
      }
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  );
  // Without this, a tab that received a 429/503 and is closed without an
  // active run consuming the record leaks a `recentByTab` entry for the
  // service-worker lifetime. Mirror the `tab-manager` cleanup on tab close.
  if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      recentByTab.delete(tabId);
    });
  }
}

/**
 * Return `true` (and clear the record) when the tab had a fresh 429/503
 * main-frame response within {@link RATE_LIMIT_TTL_MS}. Consuming the record
 * avoids re-reporting the same rate-limit on every subsequent navigator step.
 */
export function consumeRecentRateLimit(tabId: number): boolean {
  const at = recentByTab.get(tabId);
  if (at === undefined) return false;
  recentByTab.delete(tabId);
  return Date.now() - at <= RATE_LIMIT_TTL_MS;
}
