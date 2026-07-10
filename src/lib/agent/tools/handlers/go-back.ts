/** `go_back` action handler — `history.back()` + page-change detection. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import type { ActionContext } from "./types";

export async function handleGoBack(
  ctx: ActionContext,
  action: Extract<Action, { type: "go_back" }>,
): Promise<ActionResult> {
  history.back();
  await sleep(TIMINGS.navigationBack);
  return { action, success: true, message: "Navigated back", pageChanged: location.href !== ctx.beforeUrl };
}
