/**
 * options/prompts.ts — system-prompt editor + quick-prompt CRUD.
 *
 * Two prompt-override textareas (navigator + planner) plus the default system
 * prompt, all persisted to chrome.storage.local on change. A small quick-
 * prompt CRUD list is also persisted. Every mutation flashes the same shared
 * "Saved" cue (REDESIGN-PLAN §4: "auto-persist, but show 'Saved' cue
 * consistently").
 */

import { $ } from "@/extension/shared";
import { STORAGE_KEYS, showSaved } from "./settings-sync";
import { alertModal } from "./modal";

interface QuickPrompt {
  name: string;
  text: string;
}

// ─── Field constraints ───────────────────────────────────────────────────────
const NAME_MAX = 64;
const TEXT_MAX = 5_000;

// ─── Mutation serialization ──────────────────────────────────────────────────
let mutationQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Defensive storage parsing ───────────────────────────────────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateQuickPrompts(raw: unknown): QuickPrompt[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn("[prompts] stored quick-prompts value is not an array; ignoring.", raw);
    return [];
  }
  const out: QuickPrompt[] = [];
  raw.forEach((entry, i) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.text !== "string") {
      console.warn(`[prompts] dropping malformed quick-prompt at index ${i}.`, entry);
      return;
    }
    out.push({ name: entry.name, text: entry.text });
  });
  return out;
}

/** Load the persisted custom prompts into the textareas. */
export async function loadPrompts(): Promise<void> {
  let res: Record<string, unknown>;
  try {
    res = await chrome.storage.local.get([
      "customNavigatorPrompt",
      "customPlannerPrompt",
      STORAGE_KEYS.defaultTask,
      STORAGE_KEYS.quickPrompts,
    ]);
  } catch (e) {
    console.warn("[prompts] failed to load prompts:", e);
    return;
  }
  ($("customNavigatorPrompt") as HTMLTextAreaElement).value = (res.customNavigatorPrompt as string) || "";
  ($("customPlannerPrompt") as HTMLTextAreaElement).value = (res.customPlannerPrompt as string) || "";
  ($("defaultTask") as HTMLTextAreaElement).value = (res.defaultTask as string) || "";
  renderQuickPrompts(validateQuickPrompts(res.quickPrompts));
}

// Save prompts on change (textareas fire `change` on blur).
const navPromptEl = $("customNavigatorPrompt") as HTMLTextAreaElement;
navPromptEl.addEventListener("change", () => {
  chrome.storage.local
    .set({ customNavigatorPrompt: navPromptEl.value })
    .then(() => showSaved())
    .catch(async (err) => {
      await alertModal({
        title: "Save failed",
        message: `Could not save navigator prompt: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
});
const planPromptEl = $("customPlannerPrompt") as HTMLTextAreaElement;
planPromptEl.addEventListener("change", () => {
  chrome.storage.local
    .set({ customPlannerPrompt: planPromptEl.value })
    .then(() => showSaved())
    .catch(async (err) => {
      await alertModal({
        title: "Save failed",
        message: `Could not save planner prompt: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
});
// NOTE: `defaultTask` persistence is owned by `settings-sync.ts` (its
// `initAutoSave` writes the full settings snapshot, which already includes
// `defaultTask`). A second change-listener here would be redundant and risk
// divergence, so it is intentionally NOT registered.

// ─── Quick-prompt CRUD ───────────────────────────────────────────────────────

/**
 * Show a styled, non-blocking inline validation error (replacing the previous
 * native `alert()` calls, which are jarring and inconsistent with the rest of
 * the options UI). The message auto-dismisses.
 */
function flashFieldError(message: string): void {
  const host = (($("quickPromptName") as HTMLElement | null)?.parentElement) ?? document.body;
  // Only one error at a time — drop a stale one before showing the new message.
  host.querySelector(".qp-field-error")?.remove();
  const el = document.createElement("div");
  el.className = "qp-field-error";
  el.setAttribute("role", "alert");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function readQuickPrompts(): Promise<QuickPrompt[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.quickPrompts);
  return validateQuickPrompts(res[STORAGE_KEYS.quickPrompts]);
}

function renderQuickPrompts(items: QuickPrompt[]): void {
  const list = $("quickPromptsList") as HTMLDivElement;
  list.setAttribute("aria-live", "polite");
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-hint">No quick prompts saved.</p>';
    return;
  }
  items.forEach((q, index) => {
    const item = document.createElement("div");
    item.className = "quick-prompt-item";
    const nameSpan = document.createElement("span");
    nameSpan.className = "qp-name";
    nameSpan.textContent = q.name;
    const textSpan = document.createElement("span");
    textSpan.className = "qp-text";
    textSpan.textContent = q.text.slice(0, 80);
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "qp-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      void serialize(async () => {
 // Delete by index, not by name, so a pre-existing duplicate name
 // cannot mass-delete sibling entries. The captured render-time index may be
 // stale if another tab / external storage write mutated the list before this
 // click, so re-verify identity before splicing and abort + re-render on
 // mismatch.
        const current = await readQuickPrompts();
        const target = current[index];
        if (!target || target.name !== q.name) {
          renderQuickPrompts(current);
          return;
        }
        current.splice(index, 1);
        try {
          await chrome.storage.local.set({ [STORAGE_KEYS.quickPrompts]: current });
          renderQuickPrompts(current);
          showSaved();
        } catch (err) {
          await alertModal({
            title: "Delete failed",
            message: `Could not delete quick prompt: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    });
    item.append(nameSpan, textSpan, deleteBtn);
    list.appendChild(item);
  });
}

document.getElementById("addQuickPrompt")?.addEventListener("click", () => {
  void serialize(async () => {
    const name = ($("quickPromptName") as HTMLInputElement).value.trim();
    const text = ($("quickPromptText") as HTMLInputElement).value.trim();
    if (!name || !text) return;
    if (name.length > NAME_MAX) {
      flashFieldError(`Quick-prompt name must be at most ${NAME_MAX} characters.`);
      return;
    }
    if (text.length > TEXT_MAX) {
      flashFieldError(`Quick-prompt text must be at most ${TEXT_MAX} characters.`);
      return;
    }
    const items = await readQuickPrompts();
 // Enforce name uniqueness: overwrite the existing entry instead of adding a
 // second one, so delete-by-name (and delete-by-index) stays safe.
    const idx = items.findIndex((q) => q.name === name);
    if (idx >= 0) items[idx] = { name, text };
    else items.push({ name, text });
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.quickPrompts]: items });
      ($("quickPromptName") as HTMLInputElement).value = "";
      ($("quickPromptText") as HTMLInputElement).value = "";
      renderQuickPrompts(items);
      showSaved();
    } catch (err) {
      await alertModal({
        title: "Save failed",
        message: `Could not save quick prompt: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
});
