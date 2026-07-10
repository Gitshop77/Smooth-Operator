/**
 * options/index.ts — entry point for the Options page logic.
 *
 * Wires the top-of-page tab switcher (which lazily renders the active tab's
 * content) and imports every options/* submodule to trigger their top-level
 * side effects (form hydration, addEventListener registration, settings
 * load). The actual feature logic lives in the sibling modules:
 *   - settings-sync        — STORAGE_KEYS, load/save, secrets
 *   - provider-config-ui   — provider metadata, test-connection, model search
 *   - scheduled-tasks      — schedule form + chrome.alarms arming
 *   - custom-tools         — user-defined JS snippets
 *   - skills               — per-domain Markdown skills
 *   - history              — run history list + export/import
 *   - prompts              — custom navigator/planner prompt editor
 *   - notifications        — completion-notification + webhook settings
 *
 * `options.ts` (the esbuild entry) is a one-line side-effect import of this
 * file.
 */

import { renderSecrets } from "./settings-sync";
import { renderSchedule } from "./scheduled-tasks";
import { renderTools } from "./custom-tools";
import { renderSkills } from "./skills";
import { renderHistory } from "./history";
import { loadPrompts } from "./prompts";
import { loadNotifications } from "./notifications";

// Import the remaining modules for their top-level side effects (form
// hydration, addEventListener calls). settings-sync + provider-config-ui
// together run the load-settings + provider-UI hydration; the imports above
// already pull in settings-sync (for renderSecrets), and the imports below
// pull in provider-config-ui (no exported symbols needed by index.ts).
// `vision-status` wires up the Local Vision Assistant status badge + progress
// bar (previously dead UI in options.html — see vision-status.ts for the
// full backstory).
import "./provider-config-ui";
import "./vision-status";

// ─── Tab switching ─────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll<HTMLElement>(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    const target = tab.dataset.tab;
    if (!target) return;
    const panel = document.querySelector<HTMLElement>(`.tab-content[data-tab="${target}"]`);
    panel?.classList.add("active");
    if (target === "secrets") void renderSecrets();
    if (target === "schedule") void renderSchedule();
    if (target === "tools") void renderTools();
    if (target === "skills") void renderSkills();
    if (target === "history") void renderHistory();
    if (target === "prompts") void loadPrompts();
    if (target === "notifications") void loadNotifications();
  });
});
