/**
 * background/screenshots.ts — self-contained screenshot-capture helper
 * extracted from `run-helpers.ts`.
 *
 * Captures a single JPEG screenshot of a SPECIFIC agent tab via the CDP
 * debugger (attaching + detaching around the call). Used by the
 * `detect_visual` flow so vision detections are for the agent's tab, not the
 * user's visible tab. References only `chrome.*` + the dynamically-imported
 * CDP controller — no `run-helpers.ts` module state — so it is safe to
 * isolate. Behavior is byte-for-byte identical to the inline block that
 * previously lived in `handleDetectVisualRequest`.
 */

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
  const { attachDebugger, detachDebugger } = await import("@/lib/agent/cdp-controller");
  await attachDebugger(tabId);
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
    }) as { data?: string };
    if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
    return `data:image/jpeg;base64,${result.data}`;
  } finally {
    // always detach — even on throw. Mirrors CDP_CLICK / SCREENSHOT.
    detachDebugger(tabId).catch(() => { /* tab may already be closed */ });
  }
}
