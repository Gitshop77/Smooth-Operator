/**
 * `extract` action handler — return the page's visible text (capped at
 * {@link LIMITS.extractBodyChars}) tagged with the user's query.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS, TIMINGS, sleep } from "../constants";
import type { ActionContext } from "./types";

export async function handleExtract(
  _ctx: ActionContext,
  action: Extract<Action, { type: "extract" }>,
): Promise<ActionResult> {
  await sleep(TIMINGS.extractWait);
  const bodyText = (document.body?.innerText || "").slice(0, LIMITS.extractBodyChars);
  const tagged = `Query: ${action.query}\n\nPage content:\n${bodyText}`;
  return {
    action,
    success: true,
    message: `Extracted page content for query "${action.query.slice(0, 50)}" (${bodyText.length} chars)`,
    extractedContent: tagged,
  };
}
