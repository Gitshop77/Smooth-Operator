/**
 * `upload_file` action handler — file uploads require a real filesystem path
 * (CDP `DOM.setFileInputFiles`), which the LLM can't supply. Returns an
 * honest error directing the agent to use `takeover` so the user can pick
 * the file via the native file picker.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { resolveElement } from "../helpers";
import type { ActionContext } from "./types";

export async function handleUploadFile(
  ctx: ActionContext,
  action: Extract<Action, { type: "upload_file" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  const el = resolveElement(state, action.index);
  if (!(el instanceof HTMLInputElement) || el.type !== "file") {
    throw new Error(`element [${action.index}] is not a file input`);
  }
  // File uploads require a real file path on the user's filesystem
  // (CDP `DOM.setFileInputFiles` takes absolute paths, not File
  // objects). The agent LLM has no access to filesystem paths, so we
  // cannot honor this action autonomously. Return an honest error so
  // the agent can plan to use `takeover` (the user manually picks the
  // file via the native file picker). DO NOT claim success — the
  // previous stub returned `success: true` without uploading anything.
  return {
    action,
    success: false,
    message:
      "upload_file is not supported in autonomous mode — file uploads require a user-selected path. " +
      "Use the `takeover` action so the user can pick the file manually.",
  };
}
