/**
 * options/prompts.ts — C17 custom prompt editor.
 *
 * Two textareas (navigator + planner) persisted to chrome.storage.local on
 * change. No explicit save button — textareas fire `change` on blur.
 */

import { $ } from "@/extension/shared";

/** Load the persisted custom prompts into the textareas. */
export async function loadPrompts(): Promise<void> {
  const res = await chrome.storage.local.get(["customNavigatorPrompt", "customPlannerPrompt"]);
  ($("customNavigatorPrompt") as HTMLTextAreaElement).value = (res.customNavigatorPrompt as string) || "";
  ($("customPlannerPrompt") as HTMLTextAreaElement).value = (res.customPlannerPrompt as string) || "";
}

// Save prompts on change (no explicit save button needed — they're textareas).
$("customNavigatorPrompt")?.addEventListener("change", () => {
  chrome.storage.local.set({ customNavigatorPrompt: ($("customNavigatorPrompt") as HTMLTextAreaElement).value });
});
$("customPlannerPrompt")?.addEventListener("change", () => {
  chrome.storage.local.set({ customPlannerPrompt: ($("customPlannerPrompt") as HTMLTextAreaElement).value });
});
