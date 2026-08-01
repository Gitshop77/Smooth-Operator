/** `wait` action handler — sleep for N seconds (default 3, bounded 0–300). */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { sleep } from "../constants";
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
