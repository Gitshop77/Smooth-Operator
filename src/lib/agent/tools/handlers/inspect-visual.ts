import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/**
 * Request a one-shot screenshot for the main multimodal navigator.
 * Capture happens at the next observation so the image is fresh and never
 * enters text history or an action-result payload as base64.
 */
export function handleInspectVisual(
  _ctx: ActionContext,
  action: Extract<Action, { type: "inspect_visual" }>,
): ActionResult {
  return {
    action,
    success: true,
    message: `Visual inspection requested: ${action.reason}`,
    requestVisualInspection: true,
  };
}
