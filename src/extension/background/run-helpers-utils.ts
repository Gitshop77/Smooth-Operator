import type { AgentAction } from "@/lib/agent/types";
import { stripUrlFragment } from "./vision";
import { getPageSnapshot } from "./tab-manager";

// ─── Pure helpers ───────────────────────────────────────────────────────────

function confirmationDetail(action: AgentAction): string {
  const a = action as unknown as {
    type: string; text?: string; keys?: string; index?: number | string; indexStr?: string;
  };
  switch (a.type) {
    case "input":
      return ` value "${a.text ?? ""}"`;
    case "click":
      return ` on element ${a.index ?? a.indexStr ?? ""}`;
    case "send_keys":
      return ` keys "${a.keys ?? ""}"`;
    default:
      return "";
  }
}

export function confirmationMessage(action: AgentAction): string {
  return `Allow the agent to perform: ${action.type}${confirmationDetail(action)}?`;
}

export function isTransientVisionError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  const m = msg.toLowerCase();
  return /timeout|timed out|network|abort|econn|enotfound|etimedout|socket|fetch|quota|exceeded|terminated|evicted|disconnected|failed to fetch|download|interrupt/i.test(
    m,
  );
}

// ─── Vision cache state ─────────────────────────────────────────────────────

type VisionElementData = { x: number; y: number; width: number; height: number; label: string };

export const visionElementsCache = new Map<string, VisionElementData>();

let _visionCacheUrl = "";
let _visionCacheFingerprint = "";
let _visionCacheViewport = "";

export function getVisionCacheUrl(): string { return _visionCacheUrl; }
export function setVisionCacheUrl(url: string): void { _visionCacheUrl = url; }
export function setVisionCacheFingerprint(fp: string): void { _visionCacheFingerprint = fp; }
export function setVisionCacheViewport(vp: string): void { _visionCacheViewport = vp; }

export function getVisionElementRect(
  visionId: string,
): VisionElementData | undefined {
  return visionElementsCache.get(visionId);
}

export async function isVisionCacheFresh(
  tabId: number,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  if (!_visionCacheUrl) return false;
  let url: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url;
  } catch {
    return false;
  }
  if (!url) return false;
  if (stripUrlFragment(url) !== stripUrlFragment(_visionCacheUrl)) return false;
  if (_visionCacheFingerprint) {
    try {
      // One round trip for both: the fingerprint catches DOM changes; the
      // viewport signature catches a pure scroll/resize (the DOM fingerprint
      // does NOT move on scroll by design, but every cached [vN] rect is
      // scroll-relative — serving a pre-scroll detection set after the page
      // scrolled would mislocalize every vision-guided click).
      const snap = await getPageSnapshot(tabId, opts);
      if (!snap.fingerprint || snap.fingerprint !== _visionCacheFingerprint) return false;
      if (!snap.viewport || snap.viewport !== _visionCacheViewport) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function clearVisionCache(): void {
  visionElementsCache.clear();
  _visionCacheUrl = "";
  _visionCacheFingerprint = "";
  _visionCacheViewport = "";
}

export const ADAPTIVE_VISION_IDLE_STEPS = 5;

// ─── Warm-hold / auto-offload policy ─────────────────────────────────────────
// Local Vision is fast enough now (LFM2.5-VL-450M q4, ~649 MB) that it can be
// kept resident while in use, but it should still release the WebGPU sessions
// after a short idle window so it is not held forever. The hold length scales
// with how expensive a reload is: a slow load pays a high offload/reload tax,
// so it stays warm longer; a fast load can offload sooner.

export const VISION_WARM_HOLD_DEFAULT_MS = 120_000; // 2 minutes
const VISION_WARM_HOLD_SLOW_LOAD_MS = 300_000; // 5 minutes when (re)load is expensive
const VISION_SLOW_LOAD_THRESHOLD_MS = 4_000; // init/detect > 4s → treat as slow

/**
 * How long to keep the Local Vision assistant resident after its last use
 * before auto-offloading, scaled by how expensive a (re)load is. A load at or
 * below `VISION_SLOW_LOAD_THRESHOLD_MS` is the cheap fast path, so the 2-minute
 * hold is used; a slower load gets the longer hold to amortize the reload tax.
 */
export function computeVisionWarmHoldMs(loadMs: number | null): number {
  if (loadMs !== null && loadMs > VISION_SLOW_LOAD_THRESHOLD_MS) {
    return VISION_WARM_HOLD_SLOW_LOAD_MS;
  }
  return VISION_WARM_HOLD_DEFAULT_MS;
}
