/**
 * options/custom-tools.ts — user-defined JavaScript snippets the agent can
 * invoke via the existing `evaluate` action.
 *
 * Stored under the `__opencowork_custom_tools` key in chrome.storage.local —
 * same shape as the `CustomTool` type in `src/lib/agent/tools/registry.ts`.
 * The agent runtime (registry.ts) loads them at extension startup and exposes
 * them to the navigator prompt as a `<custom_tools>` block.
 */

import { $ } from "@/extension/shared";
import { CUSTOM_TOOL_NAME_REGEX } from "@/lib/agent/tools/registry";
import { STORAGE_KEYS } from "./settings-sync";

/** A user-defined custom tool — see `src/lib/agent/tools/registry.ts` for the canonical type. */
interface CustomToolEntry {
  name: string;
  description: string;
  code: string;
  createdAt?: number;
}

async function readCustomTools(): Promise<CustomToolEntry[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.customTools);
  return (res[STORAGE_KEYS.customTools] as CustomToolEntry[]) || [];
}

async function writeCustomTools(tools: CustomToolEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.customTools]: tools });
}

/** Render the custom tools list. Call after every mutation. */
export async function renderTools(): Promise<void> {
  const tools = await readCustomTools();
  const list = $("toolsList") as HTMLDivElement;
  list.innerHTML = "";
  if (tools.length === 0) {
    list.innerHTML =
      '<p class="empty-hint">No custom tools defined. Add one above.</p>';
    return;
  }
  for (const t of tools) {
    const item = document.createElement("div");
    item.className = "tool-item";
    const header = document.createElement("div");
    header.className = "tool-header";
    const nameSpan = document.createElement("span");
    nameSpan.style.fontWeight = "500";
    nameSpan.textContent = t.name;
    const descSpan = document.createElement("span");
    descSpan.className = "tool-desc";
    descSpan.textContent = t.description;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete custom tool "${t.name}"?`)) return;
      const filtered = tools.filter((x) => x.name !== t.name);
      await writeCustomTools(filtered);
      await renderTools();
    });
    header.appendChild(nameSpan);
    header.appendChild(descSpan);
    header.appendChild(delBtn);
    const code = document.createElement("pre");
    code.textContent = t.code;
    item.appendChild(header);
    item.appendChild(code);
    list.appendChild(item);
  }
}

$("addTool").addEventListener("click", async () => {
  const name = ($("toolName") as HTMLInputElement).value.trim();
  const description = ($("toolDesc") as HTMLInputElement).value.trim();
  const code = ($("toolCode") as HTMLTextAreaElement).value;
  if (!name) {
    ($("toolName") as HTMLInputElement).focus();
    return;
  }
  if (!description) {
    ($("toolDesc") as HTMLInputElement).focus();
    return;
  }
  if (!code.trim()) {
    ($("toolCode") as HTMLTextAreaElement).focus();
    return;
  }
  // Name validation — uses the canonical regex from registry.ts so the
  // options page and the runtime always agree on what's a valid tool name.
  if (!CUSTOM_TOOL_NAME_REGEX.test(name)) {
    alert(
      "Invalid tool name. Must start with a lowercase letter, contain only lowercase letters / digits / underscores, and be at most 64 characters.",
    );
    return;
  }
  const tools = await readCustomTools();
  const idx = tools.findIndex((t) => t.name === name);
  const entry: CustomToolEntry = { name, description, code, createdAt: Date.now() };
  if (idx >= 0) {
    // Preserve original createdAt on update (same tool, new version).
    entry.createdAt = tools[idx].createdAt;
    tools[idx] = entry;
  } else {
    tools.push(entry);
  }
  await writeCustomTools(tools);
  ($("toolName") as HTMLInputElement).value = "";
  ($("toolDesc") as HTMLInputElement).value = "";
  ($("toolCode") as HTMLTextAreaElement).value = "";
  await renderTools();
});
