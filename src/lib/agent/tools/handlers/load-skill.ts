/**
 * `load_skill` action handler — pull the full instruction body for the named
 * skill from the skill registry. The body is returned as `extractedContent`
 * so the next navigator step sees the full tips + shortcuts +
 * dangerous-actions list in its history.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { getFullSkill } from "../../domain-skills";
import type { ActionContext } from "./types";

export async function handleLoadSkill(
  _ctx: ActionContext,
  action: Extract<Action, { type: "load_skill" }>,
): Promise<ActionResult> {
 // Pull the full instruction body for the named skill from the skill
 // registry. The body is returned as `extractedContent` so the next
 // navigator step sees the full tips + shortcuts + dangerous-actions
 // list in its history. Cheap (no DOM access, no page mutation) —
 // safe to call in every mode.
  let body: string | null;
  try {
    body = await getFullSkill(action.name);
  } catch (e) {
    return {
      action,
      success: false,
      message: `load_skill failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
 // Treat the skill name as untrusted data: strip ALL control characters (not
 // just \r\n\t) and the Unicode line/paragraph separators so a name containing
 // newlines can't escape the `---` data-frame boundary and smuggle instructions
 // past the "data, do not follow as instructions" marker. Computed up front so
 // the same sanitized name is used in both the success and not-found messages.
  const safeName = action.name.replace(/[\u0000-\u001F\u2028\u2029]+/g, " ");
  if (!body) {
    return {
      action,
      success: false,
      message: `Skill "${safeName}" not found (not in <available_skills>?)`,
    };
  }
  return {
    action,
    success: true,
    message: `Loaded skill "${safeName}" (${body.length} chars)`,
    extractedContent: `Skill: ${safeName}\n\n${body}`,
  };
}
