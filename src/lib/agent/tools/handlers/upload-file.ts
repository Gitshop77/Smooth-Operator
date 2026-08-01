/**
 * `upload_file` action handler.
 *
 * `upload_file` requires a real filesystem path (CDP `DOM.setFileInputFiles`,
 * which takes absolute paths, not File objects) that the LLM cannot supply,
 * so an autonomous upload can never be honored. We therefore:
 * 1. Resolve the target element with {@link resolveElement} — this throws a
 * typed `NoSuchElementException` ("…not found…") when the index is
 * missing/stale, preserving the executor's "element disappeared" →
 * re-extract contract (and the test's typed-throw assertion).
 * 2. Reject (typed throw) any element that is not a file input, so the agent
 * gets a clear, actionable error instead of a silent no-op.
 * 3. Return an HONEST `success: false` result for a genuine file input —
 * never `success: true` — directing the agent to fall back to `takeover`
 * so the user can pick the file via the native file picker.
 *
 * NOTE: `action.path` (declared in the schema) is intentionally unused dead
 * contract surface — the upload can never be honored in autonomous mode, so a
 * `path` value is meaningless. The schema field should be dropped
 * once/if a future implementation honors it. Do not treat `path` as honored.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { resolveElement } from "../helpers/element-resolver";

export async function handleUploadFile(
  ctx: ActionContext,
  action: Extract<Action, { type: "upload_file" }>,
): Promise<ActionResult> {
  // Resolve the target element. Throws (NoSuchElementException, message
  // contains "not found") if the index is missing or stale — the documented
  // "element disappeared" → re-extract-state contract. Restores the typed
  // throw the test suite asserts for a missing selector.
  const el = resolveElement(ctx.state, action.index);

  // File uploads require a real `<input type="file">`. If the resolved element
  // is anything else, fail closed with a plain (untyped) Error rather than
  // silently doing nothing (which would send the agent into a confusing retry
  // loop). The executor's structured failure path surfaces this as a thrown
  // rejection the caller handles.
  // Duck-typed check: `HTMLInputElement` is a DOM global that throws a
  // TypeError under `instanceof` in a non-DOM realm (service-worker/Node
  // harness). The tagName/type test yields identical results for a genuine
  // file input and fails closed safely otherwise. tagName is compared
  // case-insensitively so non-HTML namespaces ("input") still match.
  if (
    !el ||
    ((el as unknown as { tagName?: string }).tagName || "").toUpperCase() !== "INPUT" ||
    (el as unknown as { type?: string }).type !== "file"
  ) {
    throw new Error(
      `element [${action.index}] is not a file input — upload_file requires a file input (type="file")`,
    );
  }

  // Autonomous upload can never be honored: CDP `DOM.setFileInputFiles`
  // needs an absolute path on the user's filesystem, which the LLM can't
  // supply. Return an honest failure (NEVER `success: true`) so the agent
  // plans to use `takeover` (the user manually picks the file via the native
  // picker). DO NOT claim success — the previous stub returned `success: true`
  // without uploading anything.
  return {
    action,
    success: false,
    message:
      "upload_file is not supported in autonomous mode — file uploads require a user-selected path. " +
      "Use the `takeover` action so the user can pick the file manually.",
  };
}
