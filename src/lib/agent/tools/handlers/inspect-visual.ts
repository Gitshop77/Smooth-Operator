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
    // Truthful one-shot feedback: the frame is QUEUED and arrives with the
    // NEXT observation, not this turn. Claiming "requested" as a completed
    // success made the model re-issue identical inspect_visual calls every
    // step — identical `reason` → identical loop-detector hash → spurious
    // "LOOP DETECTED: repeated Nx" warnings for a request that was already
    // in flight.
    message:
      `Visual inspection queued: a fresh viewport screenshot will be attached to your NEXT observation. ` +
      `Do not call inspect_visual again until you have seen that image. Requested for: ${action.reason}`,
    requestVisualInspection: true,
  };
}
