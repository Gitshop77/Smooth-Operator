/**
 * CDP (Chrome DevTools Protocol) controller — pixel-perfect clicks via
 * chrome.debugger.
 *
 * This module is wired into the executor as a click fallback. When
 * `el.click()` doesn't cause a page change (React synthetic events, shadow
 * DOM, jQuery), the executor sends a `CDP_CLICK` message to the background
 * script, which calls `cdpClick()` via `Input.dispatchMouseEvent`.
 *
 * This is the production-grade way to interact with pages — `element.click()`
 * silently fails on ~30% of real websites (React synthetic events, shadow
 * DOM, jQuery listeners). CDP `Input.dispatchMouseEvent` triggers every
 * listener.
 *
 * The chrome.debugger API shows an "is debugging this tab" infobar — this is
 * unavoidable in stock Chrome. The user must accept it once.
 */

/** CDP debugger protocol version this module targets. */
const CDP_PROTOCOL_VERSION = "1.3";

/** Delay (ms) between mouse-move and mouse-press — matches human behavior. */
const MOUSE_MOVE_SETTLE_MS = 100;

/** CDP modifier bitmask flags. */
const MODIFIER_ALT = 1;
const MODIFIER_CTRL = 2;
const MODIFIER_META = 4;
const MODIFIER_SHIFT = 8;

/** Default mouse button used when none is specified. */
const DEFAULT_BUTTON = "left" as const;

/** Default click count used when none is specified. */
const DEFAULT_CLICK_COUNT = 1;

/** Mouse-button options accepted by cdpClick. */
interface CdpClickOptions {
  /** Which button to press. */
  button?: "left" | "right" | "middle";
  /** Click count (1 = single, 2 = double). */
  clickCount?: number;
  /** Modifier keys to hold during the click (space-separated names). */
  modifiers?: string;
}

/**
 * Compute the CDP modifier bitmask from a modifier string.
 *
 * Recognized tokens (case-insensitive, split on `+` or whitespace):
 * - Alt
 * - Control / Ctrl
 * - Meta / Cmd / Command
 * - Shift
 */
function modifierBitmask(keys: string): number {
 // Split on `+` or whitespace, normalize to lower-case tokens for matching.
 // (Previously used `keys.includes("Alt")` etc. — that false-matched
 // "Altitude" and "ControlPanel".)
  const tokens = keys.toLowerCase().split(/[+\s]+/).filter(Boolean);
  const has = (t: string, aliases: string[]): boolean => aliases.some((a) => t === a);
  let mask = 0;
  for (const t of tokens) {
    if (has(t, ["alt", "option", "opt"])) mask |= MODIFIER_ALT;
    else if (has(t, ["control", "ctrl"])) mask |= MODIFIER_CTRL;
    else if (has(t, ["meta", "cmd", "command", "win", "super"])) mask |= MODIFIER_META;
    else if (has(t, ["shift"])) mask |= MODIFIER_SHIFT;
  }
  return mask;
}

/** True when the error indicates the debugger is already attached. */
function isAlreadyAttachedError(e: unknown): boolean {
 // Match `already attached` specifically, not any `already`-containing string.
 // A loosely-scoped `/already/i` would also classify `Target already closed`
 // or `already detached` as "attach succeeded", masking a real failure.
  return e instanceof Error && /already attached/i.test(e.message);
}

/** CDP mouse-event `type` values accepted by `Input.dispatchMouseEvent`. */
type MouseEventType = "mouseMoved" | "mousePressed" | "mouseReleased";

/** Send a single CDP `Input.dispatchMouseEvent` with the given type and params. */
async function dispatchMouseEvent(
  tabId: number,
  type: MouseEventType,
  params: Record<string, unknown>,
): Promise<void> {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type, ...params });
}

/**
 * Attach the chrome.debugger to a tab.
 * @returns `true` on success, `true` if already attached (not an error).
 */
export async function attachDebugger(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    return true;
  } catch (e: unknown) {
 // Already attached is OK.
    if (isAlreadyAttachedError(e)) return true;
    throw e;
  }
}

/** Detach the debugger from a tab. No-op if already detached. */
export async function detachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e: unknown) {
 // Already detached is benign — the target was gone before we tried.
    if (e instanceof Error && /already detached/i.test(e.message)) return;
 // Any other detach failure is unexpected (e.g. the tab still exists but the
 // debugger session errored). Surface it for observability rather than
 // swallowing everything — but do NOT rethrow from this cleanup path, since
 // `detachDebugger` is typically called from a `finally` block and rethrowing
 // would mask the original error that sent us into cleanup.
    console.warn(`[cdp-controller] detachDebugger(${tabId}) failed:`, e);
  }
}

/**
 * Click at pixel coordinates via CDP `Input.dispatchMouseEvent`.
 *
 * This triggers ALL event listeners (React, shadow DOM, jQuery) — unlike
 * `element.click()` which only fires the DOM click event. Moves the mouse
 * first so hover handlers fire.
 */
export async function cdpClick(
  tabId: number,
  x: number,
  y: number,
  options: CdpClickOptions = {}
): Promise<void> {
  const { button = DEFAULT_BUTTON, clickCount = DEFAULT_CLICK_COUNT, modifiers = "" } = options;
  const modifierMask = modifierBitmask(modifiers);
  const buttonMask = button === "right" ? 2 : button === "middle" ? 4 : 1;

 // Move mouse first (triggers mousemove/hover handlers).
  await dispatchMouseEvent(tabId, "mouseMoved", { x, y, modifiers: modifierMask });

 // Small delay between move and click (matches human behavior + lets hover handlers fire).
  await new Promise((r) => setTimeout(r, MOUSE_MOVE_SETTLE_MS));

 // Press.
  await dispatchMouseEvent(tabId, "mousePressed", {
    x,
    y,
    button,
    buttons: buttonMask,
    clickCount,
    modifiers: modifierMask,
  });

 // Release.
  await dispatchMouseEvent(tabId, "mouseReleased", {
    x,
    y,
    button,
    buttons: 0,
    clickCount,
    modifiers: modifierMask,
  });
}

/** Options for {@link cdpPressAndHold}. */
interface CdpPressAndHoldOptions {
  /**
 * Delay (ms) between `mouseMoved` and `mousePressed`. Mirrors the natural
 * hover-settle pause before a human begins a press-and-hold gesture.
 * Defaults to 0 (no extra delay — callers that want a human-like pause
 * pass `MOUSE_MOVE_SETTLE_MS` or their own value).
 */
  delay?: number;
  /**
 * How long to hold the mouse button down (ms) before releasing. This is
 * the parameter that distinguishes `cdpPressAndHold` from {@link cdpClick}
 * — a non-zero hold is what Cloudflare Turnstile and other "press and hold
 * to verify" widgets detect as a human gesture.
 */
  holdMs?: number;
}

/**
 * Press and hold at pixel coordinates using raw CDP `Input.dispatchMouseEvent`.
 *
 * Bypasses the high-level `element.click()` / `cdpClick` layer by dispatching
 * `Input.dispatchMouseEvent` directly with an explicit hold duration. Useful
 * for anti-bot challenges (Cloudflare Turnstile checkboxes, "press and hold
 * to verify" widgets) that detect automated clicks via `isTrusted` / event
 * source checks — a CDP-dispatched mouse event is treated as a real user
 * input by the browser.
 *
 * Sequence:
 * 1. `mouseMoved` to (x, y) — triggers hover/mousemove handlers.
 * 2. `mousePressed` (left button, clickCount=1) — begins the hold.
 * 3. Wait `holdMs` milliseconds — the actual "hold".
 * 4. `mouseReleased` (left button, clickCount=1) — ends the hold.
 *
 * Not cancellable once `mousePressed` is dispatched — interrupting mid-hold
 * would leave the mouse button in a pressed state, breaking subsequent
 * interactions on the page. Callers that need cancellation must wait for the
 * release to complete (it's typically a sub-second hold).
 *
 * @param tabId The tab to dispatch the events in (debugger must already be attached).
 * @param x Target X coordinate (in CSS pixels, relative to the viewport).
 * @param y Target Y coordinate (in CSS pixels, relative to the viewport).
 * @param opts Optional timing controls (`delay`, `holdMs`).
 */
export async function cdpPressAndHold(
  tabId: number,
  x: number,
  y: number,
  opts: CdpPressAndHoldOptions = {}
): Promise<void> {
  const { delay = 0, holdMs = 0 } = opts;

 // 1. Move first — triggers mousemove/hover handlers and positions the cursor
 // so the subsequent mousePressed lands on the intended element.
  await dispatchMouseEvent(tabId, "mouseMoved", { x, y, button: "none" });

 // Optional pre-press delay (e.g. to let hover animations settle).
  if (delay > 0) {
    await new Promise((r) => setTimeout(r, delay));
  }

 // 2. Press the left mouse button — begins the hold. clickCount=1 means
 // "single press" (not a double-click).
  await dispatchMouseEvent(tabId, "mousePressed", {
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });

 // 3. Hold for holdMs — this is the actual "press and hold" duration that
 // anti-bot widgets measure. Skipping this (holdMs=0) degenerates to a
 // regular click without the release-settle that Turnstile checks for.
  if (holdMs > 0) {
    await new Promise((r) => setTimeout(r, holdMs));
  }

 // 4. Release the left mouse button — completes the hold gesture.
  await dispatchMouseEvent(tabId, "mouseReleased", {
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
