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
 *
 * EXECUTION-CONFIRMATION GATE: because a custom tool's `code` runs with full
 * extension privileges (RCE / data-exfil surface), saving one requires an
 * explicit user confirmation (see the `confirmModal` gate in `addTool`). This
 * makes it impossible to plant a tool silently and forces the operator to
 * acknowledge the trust boundary before the snippet is persisted.
 */

import { $, escapeHtml } from "@/extension/shared";
import { CUSTOM_TOOL_NAME_REGEX } from "@/lib/agent/tools/registry";
import { showSaved } from "./settings-sync";
import { confirmModal, alertModal } from "./modal";
import {
  type CustomToolEntry,
  DESC_MAX,
  CODE_MAX,
  serialize,
  readCustomTools,
  writeCustomTools,
  computeCodeHash,
  dangerousCodeWarnings,
} from "./custom-tools-utils";

export { validateCustomTools } from "./custom-tools-utils";

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
        const current = await readCustomTools();
        const target = current[index];
        // Legacy entries lack `createdAt` — fall back to `codeHash`
        // for identity so a stale render snapshot can't delete a re-created
        // tool whose code changed (name-only matching is the last resort).
        const sameIdentity =
          t.createdAt !== undefined
            ? target?.createdAt === t.createdAt
            : t.codeHash !== undefined
              ? target?.codeHash === t.codeHash
              : true;
        if (
          !target ||
          target.name !== t.name ||
          !sameIdentity
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
      }).catch((e) => console.warn("[custom-tools] storage mutation failed:", e));
    });
    header.appendChild(nameSpan);
    header.appendChild(descSpan);
    header.appendChild(delBtn);
    const code = document.createElement("pre");
    code.textContent = t.code;
    item.appendChild(header);
    item.appendChild(code);
    if (t.codeHash) {
      const hashEl = document.createElement("span");
      hashEl.className = "tool-hash";
      hashEl.textContent = `sha256:${t.codeHash}`;
      hashEl.title = "Truncated SHA-256 fingerprint of the tool code";
      item.appendChild(hashEl);
    }
    frag.appendChild(item);
  });
  list.appendChild(frag);
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
    const ack = await confirmModal({
      title: "Confirm custom tool",
      message:
        "This tool's JavaScript runs with the extension's full privileges " +
        "(it is executed via the agent's evaluate action). Only save code you " +
        "trust. Continue?",
      confirmLabel: "Save tool",
      danger: true,
    });
    if (!ack) return;

    const warnings = dangerousCodeWarnings(code);
    if (warnings.length > 0) {
      const proceed = await confirmModal({
        title: "Potentially dangerous code detected",
        message:
          "This tool's code contains patterns that may be risky:\n" +
          warnings.join("\n") +
          "\n\nThese can run with full extension privileges. Continue?",
        confirmLabel: "Save anyway",
        danger: true,
      });
      if (!proceed) return;
    }

    let tools: CustomToolEntry[];
    try {
      tools = await readCustomTools();
    } catch (e) {
      await alertModal({
        title: "Save failed",
        message: `Could not read existing tools: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    const codeHash = await computeCodeHash(code);
    const idx = tools.findIndex((t) => t.name === name);
    const entry: CustomToolEntry = { name, description, code, createdAt: Date.now(), codeHash };
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
  }).catch((e) => console.warn("[custom-tools] storage mutation failed:", e));
});

void renderToolPermissions();
