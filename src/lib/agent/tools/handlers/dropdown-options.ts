/** `dropdown_options` action handler — list the options of a native `<select>`. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { resolveElement } from "../helpers";
import { NoSuchElementException } from "../../errors";
import type { ActionContext } from "./types";

export async function handleDropdownOptions(
  ctx: ActionContext,
  action: Extract<Action, { type: "dropdown_options" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  const el = resolveElement(state, action.index);
  if (!(el instanceof HTMLSelectElement)) throw new NoSuchElementException(`element [${action.index}] is not a <select>`);
  const options = Array.from(el.options, (o, i) => {
    const label = o.textContent?.trim() || o.value;
    return `${i}: ${label}${o.value && o.value !== label ? ` (value="${o.value}")` : ""}`;
  });
  return {
    action,
    success: true,
    message: `Found ${options.length} options`,
    extractedContent: `Dropdown options for [${action.index}]:\n${options.join("\n")}`,
  };
}
