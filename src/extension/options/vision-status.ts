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
import {
  ALL_MODEL_FILE_URLS,
  CACHE_NAME,
  MODEL_DOWNLOAD_SIZE_LABEL,
} from "../vision-assistant";
import { STATUS_DISPLAY } from "./status";
import { confirmModal } from "./modal";

/**
 * Probe Cache Storage to see whether the Local Vision model is already cached.
 *
 * Used on page load to decide whether we can safely initialize the assistant
 * (loading cached sessions) *without* triggering an unexpected multi-GB
 * download. If Cache Storage is unavailable or the probe fails, we conservatively
 * return `false` so the load path never auto-downloads — the actual download
 * stays gated behind the user-driven confirm modal in the radio `change` handler.
 */
async function isModelCached(): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open(CACHE_NAME);
    const hits = await Promise.all(ALL_MODEL_FILE_URLS.map((url) => cache.match(url)));
    return hits.every((response) => response !== undefined);
  } catch {
    return false;
  }
}

type VisionAssistantInstance = import("../vision-assistant").VisionAssistant;

let visionAssistant: VisionAssistantInstance | null = null;
let visionInitInProgress = false;
let visionAbortRequested = false;

/** Best-effort cleanup when an abort was requested; returns true if it ran. */
async function abortCleanup(va: VisionAssistantInstance): Promise<boolean> {
  if (!visionAbortRequested) return false;
  try { await va.cleanup(); } catch { /* best-effort */ }
  hideStatusUI();
  return true;
}

// ─── Status badge ───────────────────────────────────────────────────────────

function updateBadge(status: VisionStatus, message?: string): void {
  const badge = $("localVisionBadge") as HTMLSpanElement;
  badge.setAttribute("role", "status");
  badge.setAttribute("aria-live", "polite");
  const display = STATUS_DISPLAY[status] ?? STATUS_DISPLAY.uninitialized;
  badge.textContent = message ? `${display.label} — ${message}` : display.label;
  badge.style.background = display.bg;
  badge.style.color = display.color;
}

function updateProgress(visible: boolean, percent?: number): void {
  const progress = $("localVisionProgress") as HTMLProgressElement;
  progress.setAttribute("aria-label", "Local vision model download progress");
  progress.max = 100;
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
      // The unpinned-weights opt-in surfaces a persistent, hard-to-miss banner
      // (the badge alone flips back to "compiling"/"ready" once the download
      // finishes, so the console.warn replacement must be durable).
      if (status === "warning") showUnpinnedWarningBanner();
    };
    va.onStatus(onStatus);
    if (await abortCleanup(va)) return;
    showStatusUI();
    updateBadge("checking");
    await va.init((p: DownloadProgress) => {
      if (visionAbortRequested) return;
      updateProgress(true, p.percent);
    });
    if (await abortCleanup(va)) return;
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
    if (!visionAssistant && !visionInitInProgress && !(await isModelCached())) {
      let ok = false;
      try {
        ok = await confirmModal({
          title: "Download Local Vision model",
          message:
            `This will download a ${MODEL_DOWNLOAD_SIZE_LABEL} model for Local Vision (cached for future use). Continue?`,
          confirmLabel: "Download",
        });
      } catch {
       // A rejected modal promise must not become an unhandled rejection in this
       // change listener — treat it as a cancel.
        ok = false;
      }
      if (!ok) {
        const disabledRadio = document.getElementById("visionMode_disabled") as HTMLInputElement | null;
        if (disabledRadio) disabledRadio.checked = true;
 // Persist the reverted (disabled) state so the radio UI and stored
 // config stay consistent — otherwise the UI would show "disabled"
 // while storage still held the previously-selected mode.
        await chrome.storage.local.set({ visionMode: "disabled", enableLocalVision: false });
        hideStatusUI();
        return;
      }
    }
    try {
      await ensureVisionAssistant();
    } catch (e) {
 // A failed init/download must not become an unhandled rejection. Surface a
 // clear error badge so the user can diagnose (e.g. storage quota / network).
      updateBadge("error", e instanceof Error ? e.message : String(e));
      updateProgress(false);
    }
  });
});

// ─── On page load: if vision mode is enabled, kick off the preview init ─────

/**
 * Surface a VISIBLE banner when Local Vision is deliberately run with
 * unverified, unpinned model weights (the `allowUnpinnedWeights()` opt-in
 * escape hatch in model-loader.ts). The supply-chain guard stays fail-closed
 * by default — this banner only appears on the deliberate opt-in path, and is
 * the user-facing counterpart of the console.warn the loader emits. The badge
 * already reflects the "warning" status; this banner makes it hard to miss.
 */
function showUnpinnedWarningBanner(): void {
  const statusEl = $("localVisionStatus") as HTMLDivElement | null;
  const fieldset = statusEl?.closest("fieldset") as HTMLElement | null;
  if (!fieldset) return;
  if (fieldset.querySelector("#visionUnpinnedWarning")) return; // de-dupe
  const banner = document.createElement("div");
  banner.id = "visionUnpinnedWarning";
  banner.className = "vision-unpinned-warning";
  banner.setAttribute("role", "alert");
  // textContent (not innerHTML) — never interpolates untrusted data.
  banner.textContent =
    "Local Vision is running with UNVERIFIED, unpinned model weights: no SHA-256 " +
    "is pinned in MODEL_FILE_HASHES, so the supply-chain guard is deliberately " +
    "relaxed via the coworkAllowUnpinnedVision opt-in. Pin every hash before shipping.";
  fieldset.appendChild(banner);
}

// Cross-context path: the service worker can opt into unpinned weights (agent
// run with Local Vision) and send a message so an open options/UI surface
// shows the warning. The in-page callback path already flips the badge to the
// "warning" status when the download happens inside this page.
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg as { type?: string }).type === "vision-unpinned-warning") {
      showUnpinnedWarningBanner();
    }
    return false;
  });
}

(async () => {
  try {
    const { visionMode, enableLocalVision } = await chrome.storage.local.get(["visionMode", "enableLocalVision"]);
    const mode = (visionMode as string) || (enableLocalVision === true ? "always" : "disabled");
    if (mode === "disabled") return;
 // Do NOT auto-download the ~2.1 GB model purely because the options page
 // loaded with Local Vision enabled. Only initialize when the model is
 // already cached — loading the cached ONNX sessions is cheap and has no
 // bandwidth/disk cost. The actual download stays gated behind the
 // user-driven confirm modal in the radio `change` handler, so a user who
 // enabled Local Vision previously is never surprised by a multi-GB download
 // the moment they open the options page.
    if (await isModelCached()) {
      await ensureVisionAssistant();
    } else {
 // Model not cached and we deliberately won't auto-download it. Surface a
 // neutral hint so the status UI isn't silently empty; the radio already
 // reflects the enabled mode, and toggling it re-triggers the download
 // confirmation.
      showStatusUI();
      updateBadge(
        "uninitialized",
        "Model not downloaded yet — re-select the vision mode to download it",
      );
    }
  } catch (e) {
 // Storage read failed (corruption / quota / policy) — local-vision init
 // is skipped, but we surface the error so the failure is diagnosable.
    console.warn("[options] vision init storage read failed:", e);
  }
})();
