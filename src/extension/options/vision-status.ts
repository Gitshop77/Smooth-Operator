/**
 * options/vision-status.ts — wires up the Local Vision Assistant status UI.
 *
 * Lazily instantiates `VisionAssistant` when local vision is enabled, surfacing
 * a badge + progress bar. Previously DEAD UI (permanently `display:none`) — now
 * driven by the radio group in the Agent tab.
 *
 * P3: the 2.1 GB download confirmation uses the styled modal (not native
 * `confirm()`); the status palette is imported from `./status` (single source);
 * visibility uses the `is-hidden` class instead of inline `style.display`.
 */

import { $ } from "@/extension/shared";
import type { DownloadProgress, StatusCallback, VisionStatus } from "../vision-assistant";
import { STATUS_DISPLAY } from "./status";
import { confirmModal } from "./modal";

type VisionAssistantInstance = import("../vision-assistant").VisionAssistant;

let visionAssistant: VisionAssistantInstance | null = null;
let visionInitInProgress = false;
let visionAbortRequested = false;

// ─── Status badge ───────────────────────────────────────────────────────────

function updateBadge(status: VisionStatus, message?: string): void {
  const badge = $("localVisionBadge") as HTMLSpanElement;
  const display = STATUS_DISPLAY[status] ?? STATUS_DISPLAY.uninitialized;
  badge.textContent = message ? `${display.label} — ${message}` : display.label;
  badge.style.background = display.bg;
  badge.style.color = display.color;
}

function updateProgress(visible: boolean, percent?: number): void {
  const progress = $("localVisionProgress") as HTMLProgressElement;
  if (visible) progress.classList.remove("is-hidden");
  else progress.classList.add("is-hidden");
  if (typeof percent === "number") {
    progress.value = Math.max(0, Math.min(100, percent));
  } else if (visible) {
    progress.value = 0;
  }
}

function showStatusUI(): void {
  ($("localVisionStatus") as HTMLDivElement).classList.remove("is-hidden");
}

function hideStatusUI(): void {
  ($("localVisionStatus") as HTMLDivElement).classList.add("is-hidden");
  updateProgress(false);
}

async function ensureVisionAssistant(): Promise<void> {
  if (visionAssistant || visionInitInProgress) return;
  visionInitInProgress = true;
  visionAbortRequested = false;
  try {
    const { VisionAssistant } = await import("../vision-assistant");
    const va = new VisionAssistant();
    const onStatus: StatusCallback = (status, message) => {
      if (visionAbortRequested) return;
      updateBadge(status, message);
      updateProgress(status === "downloading");
    };
    va.onStatus(onStatus);
    if (visionAbortRequested) {
      try { await va.cleanup(); } catch { /* fresh instance, nothing to release */ }
      return;
    }
    showStatusUI();
    updateBadge("checking");
    await va.init((p: DownloadProgress) => {
      if (visionAbortRequested) return;
      updateProgress(true, p.percent);
    });
    if (visionAbortRequested) {
      try { await va.cleanup(); } catch { /* best-effort */ }
      hideStatusUI();
      return;
    }
    visionAssistant = va;
  } catch (e) {
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

async function teardownVisionAssistant(): Promise<void> {
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
    /* best-effort */
  }
  visionAssistant = null;
  hideStatusUI();
}

// ─── Wire up the radio group ────────────────────────────────────────────────

document.querySelectorAll('input[name="visionMode"]').forEach((radio) => {
  radio.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement;
    const mode = target.value;
    if (mode === "disabled") {
      await teardownVisionAssistant();
      return;
    }
    if (!visionAssistant && !visionInitInProgress) {
      const ok = await confirmModal({
        title: "Download Local Vision model",
        message:
          "This will download a 2.1 GB model for Local Vision (cached for future use). Continue?",
        confirmLabel: "Download",
      });
      if (!ok) {
        ($("visionMode_disabled") as HTMLInputElement).checked = true;
        return;
      }
    }
    await ensureVisionAssistant();
  });
});

// ─── On page load: if vision mode is enabled, kick off the preview init ─────

(async () => {
  try {
    const { visionMode, enableLocalVision } = await chrome.storage.local.get(["visionMode", "enableLocalVision"]);
    const mode = (visionMode as string) || (enableLocalVision === true ? "always" : "disabled");
    if (mode !== "disabled") {
      await ensureVisionAssistant();
    }
  } catch {
    /* storage unavailable — non-fatal */
  }
})();
