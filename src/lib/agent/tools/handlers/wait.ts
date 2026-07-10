/** `wait` action handler — sleep for N seconds (default 3). */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { sleep } from "../constants";
import type { ActionContext } from "./types";

export async function handleWait(
  _ctx: ActionContext,
  action: Extract<Action, { type: "wait" }>,
): Promise<ActionResult> {
  const s = action.seconds ?? 3;
  await sleep(s * 1000);
  return { action, success: true, message: `Waited ${s}s` };
}
