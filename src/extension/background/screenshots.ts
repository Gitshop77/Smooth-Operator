/**
 * background/screenshots.ts — screenshot-capture helper.
 *
 * Captures a single JPEG screenshot of a SPECIFIC agent tab via the CDP
 * debugger (attaching + detaching around the call). Used by the
 * `detect_visual` flow so vision detections are for the agent's tab, not the
 * user's visible tab.
 */

import { withPageDebugger, getScreenshotQuality } from "./tab-manager";

/**
 * Capture a JPEG screenshot of the given tab via `chrome.debugger`. Attaches
 * the debugger, issues `Page.captureScreenshot`, and ALWAYS detaches (even on
 * error) — mirroring the CDP_CLICK / SCREENSHOT handler patterns. Returns a
 * `data:image/jpeg;base64,...` data URL.
 *
 * The agent's tab (`tabId`) is passed explicitly so we never capture the
 * user's *visible* tab. Using `captureVisibleTab(WINDOW_ID_CURRENT)` would
 * capture whichever tab the user was viewing — if they'd switched tabs
 * mid-run, vision detections + cached pixelRects would be for the WRONG page,
 * causing silent misclicks on `[vN]` (could be a delete/payment button).
 */
export async function captureTabScreenshot(tabId: number): Promise<string> {
 // Route through the same per-tab refcounted debugger session that
 // `extractStateFromTab` uses, so a concurrent per-step screenshot cannot
 // tear down this session mid-capture (and vice-versa). The session is only
 // detached when the last user releases it (guaranteed by `withPageDebugger`'s
 // `finally` even on error).
  const quality = await getScreenshotQuality();
  return withPageDebugger(tabId, async () => {
 // Guard against a wedged debugger session: if `sendCommand` never resolves
 // (target tab mid-crash, CDP session stalled), reject after 10s instead of
 // hanging the whole agent step until the SW is killed. The single promise
 // below uses a `settled` flag so the timeout is always cleared and the
 // losing branch's rejection is never orphaned (no unhandled rejection).
    const result = await new Promise<{ data?: string }>((resolve, reject) => {
      let settled = false;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("captureTabScreenshot timed out after 10s"));
      }, 10_000);
      (chrome.debugger.sendCommand(
        { tabId },
        "Page.captureScreenshot",
        {
          format: "jpeg",
          quality,
 // Capture only the VISIBLE viewport. CDP defaults `captureBeyondViewport`
 // to true (full scrollable page) when not specified; the vision flow
 // matches screenshots against `pixelRects` expressed in VIEWPORT coords,
 // so a full-page image would misalign clicks (see header warning). Mirror
 // the sibling capture in tab-manager.ts which passes the same flag.
          captureBeyondViewport: false,
        },
      ) as Promise<{ data?: string }>).then(
        (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
    return `data:image/jpeg;base64,${result.data}`;
  });
}
