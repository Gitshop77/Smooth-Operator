/**
 * options/prompts.ts — system-prompt editor + quick-prompt CRUD.
 *
 * Two prompt-override textareas (navigator + planner) plus the default system
 * prompt, all persisted to chrome.storage.local on change. A small quick-
 * prompt CRUD list is also persisted. Every mutation flashes the same shared
 * "Saved" cue (REDESIGN-PLAN §4: "auto-persist, but show 'Saved' cue
 * consistently").
 */

import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS, showSaved } from "./settings-sync";

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

function validateQuickPrompts(raw: unknown): QuickPrompt[] {
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
  const res = await chrome.storage.local.get([
    "customNavigatorPrompt",
    "customPlannerPrompt",
    STORAGE_KEYS.defaultTask,
    STORAGE_KEYS.quickPrompts,
  ]);
  ($("customNavigatorPrompt") as HTMLTextAreaElement).value = (res.customNavigatorPrompt as string) || "";
  ($("customPlannerPrompt") as HTMLTextAreaElement).value = (res.customPlannerPrompt as string) || "";
  ($("defaultTask") as HTMLTextAreaElement).value = (res.defaultTask as string) || "";
  renderQuickPrompts(validateQuickPrompts(res.quickPrompts));
}

// Save prompts on change (textareas fire `change` on blur).
$("customNavigatorPrompt")?.addEventListener("change", () => {
  chrome.storage.local.set({ customNavigatorPrompt: ($("customNavigatorPrompt") as HTMLTextAreaElement).value });
  showSaved();
});
$("customPlannerPrompt")?.addEventListener("change", () => {
  chrome.storage.local.set({ customPlannerPrompt: ($("customPlannerPrompt") as HTMLTextAreaElement).value });
  showSaved();
});
$("defaultTask")?.addEventListener("change", () => {
  chrome.storage.local.set({ [STORAGE_KEYS.defaultTask]: ($("defaultTask") as HTMLTextAreaElement).value });
  showSaved();
});

// ─── Quick-prompt CRUD ───────────────────────────────────────────────────────

async function readQuickPrompts(): Promise<QuickPrompt[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.quickPrompts);
  return validateQuickPrompts(res[STORAGE_KEYS.quickPrompts]);
}

function renderQuickPrompts(items: QuickPrompt[]): void {
  const list = $("quickPromptsList") as HTMLDivElement;
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = '<p class="empty-hint">No quick prompts saved.</p>';
    return;
  }
  items.forEach((q, index) => {
    const item = document.createElement("div");
    item.className = "quick-prompt-item";
    item.innerHTML =
      `<span class="qp-name">${escapeHtml(q.name)}</span>` +
      `<span class="qp-text">${escapeHtml(q.text.slice(0, 80))}</span>` +
      `<button type="button" class="qp-delete">Delete</button>`;
    item.querySelector("button")!.addEventListener("click", () => {
      void serialize(async () => {
        // Delete by index, not by name, so a pre-existing duplicate name
        // cannot mass-delete sibling entries.
        const current = await readQuickPrompts();
        current.splice(index, 1);
        await chrome.storage.local.set({ [STORAGE_KEYS.quickPrompts]: current });
        renderQuickPrompts(current);
        showSaved();
      });
    });
    list.appendChild(item);
  });
}

$("addQuickPrompt")?.addEventListener("click", () => {
  void serialize(async () => {
    const name = ($("quickPromptName") as HTMLInputElement).value.trim();
    const text = ($("quickPromptText") as HTMLInputElement).value.trim();
    if (!name || !text) return;
    if (name.length > NAME_MAX) {
      alert(`Quick-prompt name must be at most ${NAME_MAX} characters.`);
      return;
    }
    if (text.length > TEXT_MAX) {
      alert(`Quick-prompt text must be at most ${TEXT_MAX} characters.`);
      return;
    }
    const items = await readQuickPrompts();
    // Enforce name uniqueness: overwrite the existing entry instead of adding a
    // second one, so delete-by-name (and delete-by-index) stays safe.
    const idx = items.findIndex((q) => q.name === name);
    if (idx >= 0) items[idx] = { name, text };
    else items.push({ name, text });
    await chrome.storage.local.set({ [STORAGE_KEYS.quickPrompts]: items });
    ($("quickPromptName") as HTMLInputElement).value = "";
    ($("quickPromptText") as HTMLInputElement).value = "";
    renderQuickPrompts(items);
    showSaved();
  });
});
