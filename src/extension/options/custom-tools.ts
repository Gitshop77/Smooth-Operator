/**
 * options/custom-tools.ts — user-defined JavaScript snippets the agent can
 * invoke via the existing `evaluate` action.
 *
 * Stored under `__opencowork_custom_tools` in chrome.storage.local (same shape
 * as `CustomTool` in `src/lib/agent/tools/registry.ts`). The agent runtime
 * loads them at extension startup.
 *
 * P3: delete confirmation + validation errors use the styled modal; the Tools
 * tab also renders the extension's manifest permission set as badges.
 *
 * TRUST BOUNDARY: the `code` string is persisted to `chrome.storage.local` and
 * executed by the agent runtime (via the `evaluate` action) in the extension's
 * privileged context. Any actor that can write that storage key — a second
 * extension with overlapping access, a synced/compromised profile, or XSS in a
 * linked page — can plant executable JavaScript. There is deliberately no
 * source allow-list, signature, or sandbox here; treat the custom-tools store
 * as a high-trust, developer-only surface, not end-user-friendly storage.
 */

import { $, escapeHtml } from "@/extension/shared";
import { CUSTOM_TOOL_NAME_REGEX } from "@/lib/agent/tools/registry";
import { STORAGE_KEYS, showSaved } from "./settings-sync";
import { confirmModal, alertModal } from "./modal";

/** A user-defined custom tool. */
interface CustomToolEntry {
  name: string;
  description: string;
  code: string;
  createdAt?: number;
}

// ─── Field constraints ───────────────────────────────────────────────────────
// `name` is bounded by CUSTOM_TOOL_NAME_REGEX (max 64). These cap the other
// fields so a single tool cannot blow the ~5 MB chrome.storage.local quota.
const DESC_MAX = 500;
const CODE_MAX = 50_000;

// ─── Mutation serialization ──────────────────────────────────────────────────
// The add/delete handlers do a read-modify-write against storage. Two rapid
// clicks can interleave the reads so the second write clobbers the first.
// Serialize every storage mutation behind a single promise chain.
let mutationQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
 // Swallow rejections so one failed mutation doesn't poison the queue.
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Defensive storage parsing ───────────────────────────────────────────────
// Malformed / legacy storage must degrade gracefully (warn + drop bad entries)
// instead of throwing while the Tools tab renders.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateCustomTools(raw: unknown): CustomToolEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    console.warn("[custom-tools] stored value is not an array; ignoring.", raw);
    return [];
  }
  const out: CustomToolEntry[] = [];
  raw.forEach((entry, i) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.description !== "string" ||
      typeof entry.code !== "string"
    ) {
      console.warn(`[custom-tools] dropping malformed entry at index ${i}.`, entry);
      return;
    }
    const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : undefined;
    out.push({ name: entry.name, description: entry.description, code: entry.code, createdAt });
  });
  return out;
}

async function readCustomTools(): Promise<CustomToolEntry[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.customTools);
  return validateCustomTools(res[STORAGE_KEYS.customTools]);
}

async function writeCustomTools(tools: CustomToolEntry[]): Promise<void> {
 // The promise form rejects on storage failure; callers catch and surface it.
  await chrome.storage.local.set({ [STORAGE_KEYS.customTools]: tools });
}

/** Render the manifest permission set as badges (read-only, informational). */
async function renderToolPermissions(): Promise<void> {
  const host = $("toolPermissions") as HTMLDivElement | null;
  if (!host) return;
  let permissions: string[] = [];
  try {
    const manifest = chrome.runtime.getManifest();
    permissions = [
      ...((manifest.permissions as string[]) || []),
      ...((manifest.host_permissions as string[]) || []),
    ];
  } catch {
    permissions = [];
  }
  if (permissions.length === 0) {
    host.innerHTML = '<p class="empty-hint">No manifest permissions declared.</p>';
    return;
  }
 // Use the project-standard sanitizer rather than the ad-hoc `<`-only replace.
  host.innerHTML = permissions
    .map((p) => `<span class="perm-badge">${escapeHtml(p)}</span>`)
    .join("");
}

/** Render the custom tools list. Call after every mutation. */
export async function renderTools(): Promise<void> {
  const tools = await readCustomTools();
  const list = $("toolsList") as HTMLDivElement;
  list.innerHTML = "";
  if (tools.length === 0) {
    list.innerHTML = '<p class="empty-hint">No custom tools defined. Add one above.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  tools.forEach((t, index) => {
    const item = document.createElement("div");
    item.className = "tool-item";
    const header = document.createElement("div");
    header.className = "tool-header";
    const nameSpan = document.createElement("span");
    nameSpan.className = "tool-name";
    nameSpan.textContent = t.name;
    const descSpan = document.createElement("span");
    descSpan.className = "tool-desc";
    descSpan.textContent = t.description;
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "tool-delete";
    delBtn.textContent = "Delete";
    delBtn.setAttribute("aria-label", `Delete custom tool "${t.name}"`);
    delBtn.addEventListener("click", () => {
      void serialize(async () => {
        const ok = await confirmModal({
          title: "Delete custom tool",
          message: `Delete custom tool "${t.name}"?`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
 // Delete by index, not by name, so a pre-existing duplicate name
 // cannot mass-delete sibling entries. The captured render-time index may be
 // stale if another tab / external storage write mutated the list before this
 // click, so re-verify identity before splicing and abort + re-render on
 // mismatch.
        const current = await readCustomTools();
        const target = current[index];
        if (
          !target ||
          target.name !== t.name ||
          (t.createdAt !== undefined && target.createdAt !== t.createdAt)
        ) {
          await renderTools();
          return;
        }
        current.splice(index, 1);
        try {
          await writeCustomTools(current);
          await renderTools();
          showSaved();
        } catch (e) {
          await alertModal({
            title: "Save failed",
            message: `Could not delete tool: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    });
    header.appendChild(nameSpan);
    header.appendChild(descSpan);
    header.appendChild(delBtn);
    const code = document.createElement("pre");
    code.textContent = t.code;
    item.appendChild(header);
    item.appendChild(code);
    frag.appendChild(item);
  });
  list.appendChild(frag);
 // `renderToolPermissions` is invoked once at module load (the manifest
 // permission set is static and doesn't change when tools are added/deleted),
 // so it is intentionally NOT re-rendered here — avoids a redundant call.
}

$("addTool").addEventListener("click", () => {
  void serialize(async () => {
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
    if (!CUSTOM_TOOL_NAME_REGEX.test(name)) {
      await alertModal({
        title: "Invalid tool name",
        message:
          "Invalid tool name. Must start with a lowercase letter, contain only lowercase letters / digits / underscores, and be at most 64 characters.",
      });
      return;
    }
    if (description.length > DESC_MAX) {
      await alertModal({
        title: "Description too long",
        message: `Tool description must be at most ${DESC_MAX} characters.`,
      });
      return;
    }
    if (code.length > CODE_MAX) {
      await alertModal({
        title: "Code too long",
        message: `Tool code must be at most ${CODE_MAX} characters.`,
      });
      return;
    }
    const tools = await readCustomTools();
 // Enforce name uniqueness: overwrite the existing entry instead of adding a
 // second one, so delete-by-name (and delete-by-index) stays safe.
    const idx = tools.findIndex((t) => t.name === name);
    const entry: CustomToolEntry = { name, description, code, createdAt: Date.now() };
    if (idx >= 0) {
      entry.createdAt = tools[idx].createdAt;
      tools[idx] = entry;
    } else {
      tools.push(entry);
    }
    try {
      await writeCustomTools(tools);
      ($("toolName") as HTMLInputElement).value = "";
      ($("toolDesc") as HTMLInputElement).value = "";
      ($("toolCode") as HTMLTextAreaElement).value = "";
      await renderTools();
      showSaved();
    } catch (e) {
      await alertModal({
        title: "Save failed",
        message: `Could not save tool: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });
});

void renderToolPermissions();
