/**
 * background/tab-manager-utils.ts — Low-level helpers extracted from
 * tab-manager.ts: CDP debugger refcounting, screenshot quality cache,
 * content-script messaging, and content-script injection.
 */

import { injectAntiDetection, isStealthEnabled } from "@/lib/agent/anti-detection";

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

// ─── Screenshot quality cache ───────────────────────────────────────────────

let cachedScreenshotQuality: number | null = null;
let cachedScreenshotImageTokens: number | null = null;
let cachedScreenshotMaxDimension: number | null = null;
let cachedScreenshotMaxBytes: number | null = null;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === "local" &&
      (changes.screenshotQuality ||
        changes.screenshotImageTokens ||
        changes.screenshotMaxDimension ||
        changes.screenshotMaxBytes)
    ) {
      cachedScreenshotQuality = null;
      cachedScreenshotImageTokens = null;
      cachedScreenshotMaxDimension = null;
      cachedScreenshotMaxBytes = null;
    }
  });
}

export async function getScreenshotQuality(): Promise<number> {
  if (cachedScreenshotQuality !== null) return cachedScreenshotQuality;
  const { screenshotQuality } = await chrome.storage.local.get("screenshotQuality");
  cachedScreenshotQuality =
    typeof screenshotQuality === "number" ? Math.min(100, Math.max(0, screenshotQuality)) : 80;
  return cachedScreenshotQuality;
}

/** Per-image token budget for local vision models (default 4096). */
export async function getScreenshotImageTokens(): Promise<number> {
  if (cachedScreenshotImageTokens !== null) return cachedScreenshotImageTokens;
  const { screenshotImageTokens } = await chrome.storage.local.get("screenshotImageTokens");
  cachedScreenshotImageTokens =
    typeof screenshotImageTokens === "number" && screenshotImageTokens >= 256 && screenshotImageTokens <= 65536
      ? Math.floor(screenshotImageTokens)
      : 4096;
  return cachedScreenshotImageTokens;
}

/** Max screenshot dimension in CSS px; 0 keeps the full viewport. */
export async function getScreenshotMaxDimension(): Promise<number> {
  if (cachedScreenshotMaxDimension !== null) return cachedScreenshotMaxDimension;
  const { screenshotMaxDimension } = await chrome.storage.local.get("screenshotMaxDimension");
  cachedScreenshotMaxDimension =
    typeof screenshotMaxDimension === "number" && screenshotMaxDimension >= 0 && screenshotMaxDimension <= 4096
      ? Math.floor(screenshotMaxDimension)
      : 0;
  return cachedScreenshotMaxDimension;
}

/** Max screenshot byte size; 0 disables the byte cap. */
export async function getScreenshotMaxBytes(): Promise<number> {
  if (cachedScreenshotMaxBytes !== null) return cachedScreenshotMaxBytes;
  const { screenshotMaxBytes } = await chrome.storage.local.get("screenshotMaxBytes");
  cachedScreenshotMaxBytes =
    typeof screenshotMaxBytes === "number" && screenshotMaxBytes >= 0 && screenshotMaxBytes <= 5_000_000
      ? Math.floor(screenshotMaxBytes)
      : 0;
  return cachedScreenshotMaxBytes;
}

// ─── CDP debugger refcount ──────────────────────────────────────────────────

const debuggerRefCounts = new Map<number, number>();

if (typeof chrome !== "undefined") {
  chrome.debugger?.onDetach?.addListener((source) => {
    const tabId = (source as { tabId?: number }).tabId;
    if (typeof tabId === "number") debuggerRefCounts.delete(tabId);
  });
  chrome.tabs?.onRemoved?.addListener((tabId: number) => {
    debuggerRefCounts.delete(tabId);
  });
}

export async function acquirePageDebugger<T>(
  tabId: number,
  attach: (id: number) => Promise<T>,
): Promise<void> {
  const n = (debuggerRefCounts.get(tabId) ?? 0) + 1;
  debuggerRefCounts.set(tabId, n);
  try {
    await attach(tabId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already attached/i.test(msg)) return;
    const m = (debuggerRefCounts.get(tabId) ?? 1) - 1;
    if (m <= 0) debuggerRefCounts.delete(tabId);
    else debuggerRefCounts.set(tabId, m);
    throw e;
  }
}

export async function releasePageDebugger<T>(
  tabId: number,
  detach: (id: number) => Promise<T>,
): Promise<void> {
  if ((debuggerRefCounts.get(tabId) ?? 0) <= 0) return;
  const n = (debuggerRefCounts.get(tabId) ?? 0) - 1;
  if (n <= 0) {
    debuggerRefCounts.delete(tabId);
    await detach(tabId).catch(() => {});
  } else {
    debuggerRefCounts.set(tabId, n);
  }
}

export async function withPageDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const { attachDebugger, detachDebugger } = await import("@/lib/agent/cdp-controller");
  await acquirePageDebugger(tabId, attachDebugger);
  try {
    return await fn();
  } finally {
    await releasePageDebugger(tabId, detachDebugger);
  }
}

/**
 * Run a `chrome.debugger.sendCommand` call against a bounded timeout so a
 * wedged CDP session (crashed target, stalled transport) cannot hang the
 * caller or leak the per-tab debugger refcount. The single `settled` flag
 * guarantees the timer is always cleared and the losing branch's rejection is
 * never orphaned (no unhandled rejection).
 */
export function sendDebuggerCommandWithTimeout<T>(
  tabId: number,
  command: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    (chrome.debugger.sendCommand({ tabId }, command, params) as Promise<T>).then(
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
}

// ─── Content-script messaging ───────────────────────────────────────────────

const CONTENT_SCRIPT_TIMEOUT_MS = 20_000;
const PING_TIMEOUT_MS = 1_500;
const PING_POLL_TIMEOUT_MS = 500;

export async function sendMessageWithTimeout<R = unknown>(
  tabId: number,
  message: unknown,
  timeoutMs: number = CONTENT_SCRIPT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<R> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const send = chrome.tabs.sendMessage<R>(tabId, message as never);
  send.catch(() => {});
  try {
    return await Promise.race([
      send,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("content script did not respond")),
          timeoutMs,
        );
      }),
      ...(signal
        ? [new Promise<never>((_, reject) => {
            abortListener = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
            if (signal.aborted) abortListener();
            else signal.addEventListener("abort", abortListener, { once: true });
          })]
        : []),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener && signal) signal.removeEventListener("abort", abortListener);
  }
}

export async function getPageFingerprint(tabId: number): Promise<string> {
  try {
    await ensureContent(tabId);
    const res = await sendMessageWithTimeout<{ ok: boolean; fingerprint?: string }>(
      tabId,
      { type: "GET_DOM_FINGERPRINT" },
    );
    return res?.ok ? res.fingerprint ?? "" : "";
  } catch {
    return "";
  }
}

export async function ensureContent(tabId: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  try {
    const res = await sendMessageWithTimeout<{ ok: boolean } | undefined>(
      tabId,
      { type: "PING" },
      PING_TIMEOUT_MS,
      signal,
    );
    if (res?.ok) return;
  } catch (e) {
    if (signal?.aborted) throw e;
    /* not injected yet — fall through to injection */
  }
  try {
    throwIfAborted(signal);
    if (await isStealthEnabled()) {
      try {
        await injectAntiDetection(tabId);
      } catch (e) {
        console.warn(
          `[tab-manager] stealth injection failed; continuing with content script only: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      console.debug("[tab-manager] stealth patches skipped (stealthEnabled is off)");
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    for (let i = 0; i < 10; i++) {
      throwIfAborted(signal);
      try {
        const res = await sendMessageWithTimeout<{ ok: boolean } | undefined>(
          tabId,
        { type: "PING" },
        PING_POLL_TIMEOUT_MS,
        signal,
        );
        if (res?.ok) return;
      } catch (e) {
        if (signal?.aborted) throw e;
        /* keep polling */
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 50);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason instanceof Error ? signal.reason : abortError());
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new Error("content script did not become ready after injection");
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(`Cannot inject into tab ${tabId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
