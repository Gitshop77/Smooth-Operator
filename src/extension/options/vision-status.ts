/**
 * options/vision-status.ts — wires up the Local Vision Assistant status UI.
 *
 * Previously DEAD UI: `localVisionStatus`, `localVisionBadge`, and
 * `localVisionProgress` elements existed in options.html but had NO JS
 * handler attached — they were permanently `display:none`. The user had no
 * way to know whether the 2.1 GB model was downloading, ready, or errored.
 *
 * This module:
 *   - When `enableLocalVision` is checked, lazily instantiates the
 *     `VisionAssistant` and registers an `onStatus` callback that updates
 *     the badge text + color.
 *   - Shows the progress bar during download (status === "downloading"),
 *     updating it from the `DownloadProgress` callback.
 *   - When unchecked, hides the status UI and calls `cleanup()` to free
 *     VRAM held by the ONNX sessions.
 *
 * The vision assistant instance is shared with `agent-bridge.ts`'s singleton
 * via the dynamic import — both pull from the same module-level state inside
 * `inference.ts` (the `VisionAssistant` class itself is stateless w.r.t.
 * singletons; the SW and the Options page are separate contexts, so each
 * has its own instance — Options for status preview, SW for actual run-time
 * detection).
 */

import { $ } from "@/extension/shared";
import type { DownloadProgress, StatusCallback, VisionStatus } from "../vision-assistant";

/**
 * R9-FINAL: Previously typed as `any` (with an eslint-disable). Use the
 * proper `VisionAssistant` type via a dynamic-import-friendly type alias so
 * we keep static type-safety without importing the 2.1 GB ONNX deps at
 * Options-page bundle time.
 */
type VisionAssistantInstance = import("../vision-assistant").VisionAssistant;

let visionAssistant: VisionAssistantInstance | null = null;
let visionInitInProgress = false;
// abort flag — set when the user unchecks `enableLocalVision` while
// `va.init()` is still in flight (downloading the 2.1 GB model can take
// minutes). The in-flight `ensureVisionAssistant()` checks this flag after
// `await va.init()` resolves: if set, it calls `va.cleanup()` on the now-
// fully-initialized instance and does NOT assign `visionAssistant = va`.
// Without this, `teardownVisionAssistant()` would call `cleanup()` on a
// partially-initialized instance (some sessions still null) — that freed
// nothing and could throw inside `release()` paths.
let visionAbortRequested = false;

// Status → (label, color) for the badge. Uses the design-system tokens so
// the badge responds to light/dark mode like the rest of the Options page.
const STATUS_DISPLAY: Record<VisionStatus, { label: string; bg: string; color: string }> = {
  uninitialized: { label: "Not loaded",        bg: "var(--cw-raised)",  color: "var(--cw-muted)" },
  checking:      { label: "Checking cache…",   bg: "var(--cw-amber-dim)", color: "var(--cw-amber)" },
  downloading:   { label: "Downloading model…", bg: "var(--cw-amber-dim)", color: "var(--cw-amber)" },
  compiling:     { label: "Compiling ONNX…",   bg: "rgba(212,161,74,0.12)", color: "var(--cw-warn)" },
  ready:         { label: "✓ Ready",           bg: "rgba(143,174,138,0.14)", color: "var(--cw-success)" },
  error:         { label: "✗ Error",           bg: "rgba(192,87,75,0.14)", color: "var(--cw-danger)" },
};

/** Update the badge text + color from a `VisionStatus`. */
function updateBadge(status: VisionStatus, message?: string): void {
  const badge = $("localVisionBadge") as HTMLSpanElement;
  const display = STATUS_DISPLAY[status] ?? STATUS_DISPLAY.uninitialized;
  badge.textContent = message ? `${display.label} — ${message}` : display.label;
  badge.style.background = display.bg;
  badge.style.color = display.color;
}

/** Show or hide the progress bar + update its value. */
function updateProgress(visible: boolean, percent?: number): void {
  const progress = $("localVisionProgress") as HTMLProgressElement;
  progress.style.display = visible ? "block" : "none";
  if (typeof percent === "number") {
    progress.value = Math.max(0, Math.min(100, percent));
  } else if (visible) {
    progress.value = 0;
  }
}

/** Show the status container (badge + optional progress). */
function showStatusUI(): void {
  ($("localVisionStatus") as HTMLDivElement).style.display = "block";
}

/** Hide the status container entirely (used when local vision is disabled). */
function hideStatusUI(): void {
  ($("localVisionStatus") as HTMLDivElement).style.display = "none";
  updateProgress(false);
}

/**
 * Lazily create + init the vision assistant. The init() call downloads the
 * 2.1 GB model on first run, so we surface status to the user via the badge
 * + progress bar. Subsequent calls reuse the existing instance (idempotent
 * — `init()` short-circuits when `isReady` is already true).
 *
 * `visionAssistant = va` is assigned ONLY after `await va.init()`
 * succeeds. If the user unchecks `enableLocalVision` while init is in
 * flight (signalled via `visionAbortRequested`), we call `va.cleanup()`
 * ourselves once init resolves and skip the assignment — so the partially-
 * initialized instance is never exposed to `teardownVisionAssistant()`.
 */
async function ensureVisionAssistant(): Promise<void> {
  if (visionAssistant || visionInitInProgress) return;
  visionInitInProgress = true;
  visionAbortRequested = false;
  try {
    const { VisionAssistant } = await import("../vision-assistant");
    const va = new VisionAssistant();
    // Register the status callback BEFORE init so we catch the
    // checking/downloading/compiling transitions.
    const onStatus: StatusCallback = (status, message) => {
      // if the user already unchecked during init, don't re-show the
      // status UI — teardown already hid it. The status callback may still
      // fire from `va.init()`'s setStatus calls as it finishes tearing down.
      if (visionAbortRequested) return;
      updateBadge(status, message);
      // Show progress only during download; hide otherwise (the percent
      // comes from the separate onProgress callback wired below).
      updateProgress(status === "downloading");
    };
    va.onStatus(onStatus);
    // the dynamic import above can take long enough on first load that
    // the user may have already unchecked. Bail out before showing any UI.
    if (visionAbortRequested) {
      try {
        await va.cleanup();
      } catch {
        /* best-effort — fresh instance has nothing to release */
      }
      return;
    }
    showStatusUI();
    updateBadge("checking");
    await va.init((p: DownloadProgress) => {
      // Per-file progress. The badge already says "Downloading model…".
      // skip progress updates after an abort so the (hidden) progress
      // bar doesn't flicker back to visible.
      if (visionAbortRequested) return;
      updateProgress(true, p.percent);
    });
    // assign `visionAssistant = va` ONLY after init() succeeds. If the
    // user toggled off during the (potentially minutes-long) init, clean up
    // the now-fully-initialized instance so its ONNX sessions are released
    // and don't assign — otherwise `teardownVisionAssistant()` would run
    // `cleanup()` on a partially-initialized instance (the original bug).
    if (visionAbortRequested) {
      try {
        await va.cleanup();
      } catch {
        /* best-effort — cleanup() internally guards against double-release */
      }
      hideStatusUI();
      return;
    }
    visionAssistant = va;
    // Status callback already set the badge to "ready" (or "error") via
    // the `setStatus` calls inside `init()`.
  } catch (e) {
    // init() threw — the status callback already set the badge to "error"
    // (it fires `setStatus("error", message)` before re-throwing). If the
    // throw happened BEFORE setStatus ran (e.g. a synchronous throw in the
    // constructor), surface the error message manually.
    // skip the badge update if we were aborting — the UI is already
    // hidden by teardown.
    if (visionAbortRequested) {
      hideStatusUI();
    } else {
      updateBadge("error", e instanceof Error ? e.message : String(e));
      updateProgress(false);
    }
  } finally {
    visionInitInProgress = false;
    visionAbortRequested = false;
  }
}

/**
 * Tear down the vision assistant + free VRAM. Called when the user unchecks
 * `enableLocalVision`. Safe to call when no instance exists (no-op).
 *
 * if `va.init()` is still in flight, set `visionAbortRequested` instead
 * of running `cleanup()` on a partially-initialized instance. The in-flight
 * `ensureVisionAssistant()` will call `va.cleanup()` itself once init
 * resolves (cleanup() on a partial instance can throw or free nothing).
 */
async function teardownVisionAssistant(): Promise<void> {
  // init still in flight — defer cleanup to the in-flight init path.
  // Hide the UI immediately so the user gets feedback that the uncheck took
  // effect, even though the ONNX sessions will be released a few moments
  // later when init() resolves.
  if (visionInitInProgress) {
    visionAbortRequested = true;
    hideStatusUI();
    return;
  }
  if (!visionAssistant) {
    hideStatusUI();
    return;
  }
  try {
    await visionAssistant.cleanup();
  } catch {
    /* best-effort — ignore cleanup errors */
  }
  visionAssistant = null;
  hideStatusUI();
}

// ─── Wire up the checkbox ───────────────────────────────────────────────────

/**
 * On change: if checked → confirm the 2.1 GB download, then ensure + init the
 * assistant (which surfaces the status UI). If unchecked → teardown + hide.
 * The persisted `enableLocalVision` flag is written by `settings-sync.ts`'s
 * save handler — this listener only reacts to UI changes, it doesn't persist
 * (so the save button still controls persistence, matching the rest of the
 * Behavior tab).
 *
 * Auto-init kicks off the moment the user toggles the
 * checkbox on — a 2.1 GB download started without any explicit confirmation.
 * That's a lot of bandwidth + disk to spend on an accidental click. Now we
 * show a native `confirm()` dialog first. If the user cancels, we uncheck the
 * box (so the visible state matches the persisted state — the save handler
 * reads `checked`, and we don't want a checked-but-not-initialized state to
 * persist). If they confirm, we proceed with `ensureVisionAssistant()` as
 * before. The top-level IIFE below still auto-inits on page load when the
 * stored flag is already true (no re-confirmation needed — the user already
 * opted in on a previous visit).
 */
// Wire up the radio group. When the user selects "always" or "adaptive",
// confirm the 2.1 GB download + init. When "disabled", teardown.
document.querySelectorAll('input[name="visionMode"]').forEach((radio) => {
  radio.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement;
    const mode = target.value;
    if (mode === "disabled") {
      await teardownVisionAssistant();
      return;
    }
    // Skip confirm if vision is already loaded or loading (user is just
    // switching between "always" and "adaptive" — no re-download needed).
    if (!visionAssistant && !visionInitInProgress) {
      const ok = window.confirm(
        "This will download a 2.1 GB model for Local Vision (cached for future use). Continue?",
      );
      if (!ok) {
        // Revert to the previously checked radio
        ($("visionMode_disabled") as HTMLInputElement).checked = true;
        return;
      }
    }
    await ensureVisionAssistant();
  });
});

// ─── On page load: if vision mode is enabled, kick off the preview init ─────
//
// This runs as a top-level side effect when the module loads (Options page
// open). It reads the stored `visionMode` flag and, if not "disabled", starts
// the init in the background so the user sees the status badge light up.
(async () => {
  try {
    const { visionMode, enableLocalVision } = await chrome.storage.local.get(["visionMode", "enableLocalVision"]);
    const mode = (visionMode as string) || (enableLocalVision === true ? "always" : "disabled");
    if (mode !== "disabled") {
      await ensureVisionAssistant();
    }
  } catch {
    /* storage unavailable — non-fatal, the radio listener still works */
  }
})();
