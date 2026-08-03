/** `wait` action handler + the wait_for_* family (element / text / url / network-idle). */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { NETWORK_IDLE_WINDOW_MS, WAIT_POLL_MS, WAIT_TIMEOUT_MS, sleep } from "../constants";
import type { ActionContext } from "./types";

export async function handleWait(
  _ctx: ActionContext,
  action: Extract<Action, { type: "wait" }>,
): Promise<ActionResult> {
  // The schema already bounds `seconds` to [0, 300], but clamp defensively in
  // case this handler is ever invoked with a value that bypassed validation
  // (e.g. a hand-built action). `0` is preserved as a zero-second no-op wait;
  // any non-finite or out-of-range value falls back to the 3s default. Without
  // this, a negative/NaN value would fire a near-instant setTimeout(0) and an
  // unbounded value would hang the orchestrator, which awaits this handler.
  const raw = Number(action.seconds);
  const valid = Number.isFinite(raw);
  const s = valid ? Math.min(Math.max(0, raw), 300) : 3;
  await sleep(s * 1000, _ctx.signal);
  const clampedNote = !valid || raw === s ? "" : ` (requested ${String(raw)})`;
  const message = `Waited ${s}s${clampedNote}`;
  return { action, success: true, message };
}

// ─── wait_for_* family ──────────────────────────────────────────────────────

type WaitForElementAction = Extract<Action, { type: "wait_for_element" }>;
type WaitForTextAction = Extract<Action, { type: "wait_for_text" }>;
type WaitForUrlAction = Extract<Action, { type: "wait_for_url" }>;
type WaitForNetworkIdleAction = Extract<Action, { type: "wait_for_network_idle" }>;

/** Handler inputs allow omitting `timeout_seconds` / `state` (the schema fills
 *  them with defaults on the parsed path); the handlers apply the SAME defaults
 *  so a hand-built action behaves identically to a parsed one. */
type WaitForElementInput = Omit<WaitForElementAction, "timeout_seconds" | "state"> & {
  timeout_seconds?: number;
  state?: "visible" | "hidden" | "attached" | "detached";
};
type WaitForTextInput = Omit<WaitForTextAction, "timeout_seconds"> & {
  timeout_seconds?: number;
};
type WaitForUrlInput = Omit<WaitForUrlAction, "timeout_seconds"> & {
  timeout_seconds?: number;
};
type WaitForNetworkIdleInput = Omit<WaitForNetworkIdleAction, "timeout_seconds"> & {
  timeout_seconds?: number;
};

/**
 * Convert a URL glob to a RegExp (anchored). `*` matches any characters EXCEPT
 * `/`; `**` matches any characters including `/`; `?` matches one non-`/`
 * character; every other character is treated literally (regex metacharacters
 * are escaped). Anchoring matters: `*` alone must not match a multi-segment
 * path, so a glob like `https://example.com/*` only matches one path segment.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++; // consume the second `*` of the `**` pair
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

interface PollOptions {
  /** Absolute deadline (ms epoch) — hard fail when reached. */
  deadline: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  successMessage: string;
}

/**
 * Poll a condition until it passes, the deadline elapses, or the signal
 * aborts. Every poll runs a FRESH condition evaluation against the live page
 * (never a cached snapshot), so an element appearing after the first poll is
 * still caught. The sleep interval shrinks to the remaining time so an action
 * can never overrun its deadline by one full poll. Timeout is HARD: on expiry
 * the action returns `success:false` instead of succeeding with a stale state.
 * An aborted signal rejects the in-flight sleep (AbortError), propagating the
 * cancellation to the caller.
 */
async function pollUntil<T extends Action>(
  action: T,
  condition: () => boolean,
  options: PollOptions,
): Promise<ActionResult> {
  for (;;) {
    if (condition()) {
      return { action, success: true, message: options.successMessage };
    }
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      return { action, success: false, message: options.timeoutMessage };
    }
    await sleep(Math.min(WAIT_POLL_MS, remaining), options.signal);
  }
}

/** Timeout fallback (seconds) for hand-built actions that bypassed the schema
 *  (the schema default for `timeout_seconds` is 30). */
const DEFAULT_TIMEOUT_SECONDS = WAIT_TIMEOUT_MS / 1000;

function elementMatchesState(
  selector: string,
  state: "visible" | "hidden" | "attached" | "detached",
): boolean {
  const el = document.querySelector(selector);
  if (state === "attached") return el !== null;
  if (state === "detached") return el === null;
  // visible/hidden require the element to exist; a missing element can never
  // be "visible", and "hidden" for a missing element is ambiguous — treat it
  // as NOT hidden (the `detached` state exists for that case).
  if (!el) return false;
  if (state === "visible") return !isElementHidden(el);
  return isElementHidden(el);
}

function isElementHidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  try {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  } catch {
    // Detached / un-layoutable element — never "visible".
    return true;
  }
}

/** The page's visible text (innerText when available — its "only rendered
 *  text" semantics match the reference behavior; falls back to textContent
 *  where innerText is unavailable, e.g. jsdom). */
function bodyText(): string {
  const body = document.body;
  if (!body) return "";
  const t = (body as { innerText?: string }).innerText;
  return typeof t === "string" ? t : (body.textContent ?? "");
}

export async function handleWaitForElement(
  ctx: ActionContext,
  action: WaitForElementInput,
): Promise<ActionResult> {
  const resolved: WaitForElementAction = {
    ...action,
    state: action.state ?? "visible",
    timeout_seconds: action.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
  return pollUntil(
    resolved,
    () => elementMatchesState(resolved.selector, resolved.state),
    {
      deadline: Date.now() + resolved.timeout_seconds * 1000,
      signal: ctx.signal,
      timeoutMessage: `wait_for_element timed out after ${resolved.timeout_seconds}s: selector "${resolved.selector}" state "${resolved.state}"`,
      successMessage: `wait_for_element: selector "${resolved.selector}" is ${resolved.state}`,
    },
  );
}

export async function handleWaitForText(
  ctx: ActionContext,
  action: WaitForTextInput,
): Promise<ActionResult> {
  const resolved: WaitForTextAction = {
    ...action,
    timeout_seconds: action.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
  return pollUntil(
    resolved,
    () => bodyText().includes(resolved.text),
    {
      deadline: Date.now() + resolved.timeout_seconds * 1000,
      signal: ctx.signal,
      timeoutMessage: `wait_for_text timed out after ${resolved.timeout_seconds}s: text "${resolved.text}"`,
      successMessage: `wait_for_text: text "${resolved.text}" found`,
    },
  );
}

export async function handleWaitForUrl(
  ctx: ActionContext,
  action: WaitForUrlInput,
): Promise<ActionResult> {
  const resolved: WaitForUrlAction = {
    ...action,
    timeout_seconds: action.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
  const pattern = globToRegExp(resolved.url);
  return pollUntil(
    resolved,
    () => pattern.test(location.href),
    {
      deadline: Date.now() + resolved.timeout_seconds * 1000,
      signal: ctx.signal,
      timeoutMessage: `wait_for_url timed out after ${resolved.timeout_seconds}s: pattern "${resolved.url}"`,
      successMessage: `wait_for_url: URL ${location.href} matches "${resolved.url}"`,
    },
  );
}

export async function handleWaitForNetworkIdle(
  ctx: ActionContext,
  action: WaitForNetworkIdleInput,
): Promise<ActionResult> {
  const resolved: WaitForNetworkIdleAction = {
    ...action,
    timeout_seconds: action.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
  return pollUntil(
    resolved,
    () => networkIsIdle(),
    {
      deadline: Date.now() + resolved.timeout_seconds * 1000,
      signal: ctx.signal,
      timeoutMessage: `wait_for_network_idle timed out after ${resolved.timeout_seconds}s: network never went idle`,
      successMessage: "wait_for_network_idle: network idle",
    },
  );
}

/** True when no resource has loaded within {@link NETWORK_IDLE_WINDOW_MS} —
 *  measured on the performance timeline so entry startTimes and `now()` share
 *  one clock. No resource-timing support → nothing to wait for → idle. */
function networkIsIdle(): boolean {
  try {
    const entries = performance.getEntriesByType("resource");
    if (!entries || entries.length === 0) return true;
    const latest = entries[entries.length - 1].startTime;
    return performance.now() - latest >= NETWORK_IDLE_WINDOW_MS;
  } catch {
    return true;
  }
}
