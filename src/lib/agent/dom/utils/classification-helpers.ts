/** Tags that are always treated as interactive (in addition to role-based). */
export const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "button", "input", "select", "textarea", "summary", "details",
]);

/**
 * ARIA roles that imply interactivity.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "checkbox", "radio", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "combobox",
  "listbox", "slider", "switch", "textbox", "spinbutton", "searchbox",
  "treeitem", "gridcell",
]);

/** Autocomplete tokens that mark a field as sensitive. */
export const SENSITIVE_AUTOCOMPLETE_SET: ReadonlySet<string> = new Set([
  "current-password", "new-password", "one-time-code",
  "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
]);

/**
 * Read an element's ARIA `role` attribute, lowercased, or `null` when absent.
 */
export function getRole(el: Element): string | null {
  return el.getAttribute("role")?.toLowerCase() ?? null;
}
