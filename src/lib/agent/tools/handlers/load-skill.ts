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
  const body = await getFullSkill(action.name);
  if (!body) {
    return {
      action,
      success: false,
      message: `Skill "${action.name}" not found (not in <available_skills>?)`,
    };
  }
  return {
    action,
    success: true,
    message: `Loaded skill "${action.name}" (${body.length} chars)`,
    extractedContent: `Skill: ${action.name}\n\n${body}`,
  };
}
