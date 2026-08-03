/** `get_computed_style` action handler — read CSS computed style values of an element. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { resolveElement } from "../helpers";
import type { ActionContext } from "./types";

/**
 * Read the requested computed-style properties of `[index]` into a
 * `{ property: value }` record, serialized as the extractedContent.
 *
 * Both kebab-case (`background-color`) and camelCase (`backgroundColor`) names
 * resolve: kebab-case goes through `getPropertyValue` (the CSSOM API), and
 * camelCase falls back to direct property access on the CSSStyleDeclaration
 * (which exposes the camelCase form). Unknown/unset properties yield `""`.
 *
 * Missing or detached elements throw `NoSuchElementException` (the
 * element-disappeared contract, same as `hover`) so the executor re-extracts
 * state and retries.
 */
export function handleGetComputedStyle(
  ctx: ActionContext,
  action: Extract<Action, { type: "get_computed_style" }>,
): ActionResult {
  const el = resolveElement(ctx.state, action.index);
  const style = getComputedStyle(el);
  const record: Record<string, string> = {};
  for (const property of action.properties) {
    record[property] =
      style.getPropertyValue(property) ||
      ((style as unknown as Record<string, string>)[property] ?? "");
  }
  const extractedContent = JSON.stringify(record);
  return {
    action,
    success: true,
    message: `Computed style for [${action.index}] (${action.properties.length} properties)`,
    extractedContent,
  };
}
