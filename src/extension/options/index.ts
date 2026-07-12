/**
 * options/index.ts — entry point for the Options page logic.
 *
 * Wires the left-rail tab switcher (keyboard-navigable, ARIA-compliant) and
 * imports every options/* submodule to trigger their top-level side effects
 * (form hydration, addEventListener registration, settings load).
 *
 * Tabs switch via JS (no full reload). Each tab has its own ViewHeader-style
 * title + subtitle baked into options.html; switching just shows/hides panels.
 */

import { $ } from "@/extension/shared";
import { renderSecrets, initAutoSave } from "./settings-sync";
import { renderSchedule } from "./scheduled-tasks";
import { renderTools } from "./custom-tools";
import { renderSkills } from "./skills";
import { renderHistory } from "./history";
import { loadPrompts } from "./prompts";
import { loadNotifications } from "./notifications";
import "./provider-config-ui";
import "./vision-status";

// ─── Tab switching ─────────────────────────────────────────────────────────

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));

function activateTab(tab: HTMLButtonElement, focus = true): void {
  const target = tab.dataset.tab;
  if (!target) return;
  for (const t of tabs) {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
    t.tabIndex = -1;
  }
  tab.classList.add("active");
  tab.setAttribute("aria-selected", "true");
  tab.tabIndex = 0;
  if (focus) tab.focus();
  document.querySelectorAll<HTMLElement>(".tab-content").forEach((c) => {
    c.classList.toggle("active", c.dataset.tab === target);
  });
 // Lazily render dynamic tab content on first activation.
  if (target === "secrets") void renderSecrets();
  if (target === "schedule") void renderSchedule();
  if (target === "tools") void renderTools();
  if (target === "skills") void renderSkills();
  if (target === "history") void renderHistory();
  if (target === "prompts") void loadPrompts();
  if (target === "notify") void loadNotifications();
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab, false));
});

// ARIA tablist keyboard navigation (Left/Right/Up/Down/Home/End).
const tablist = $("tablist") as HTMLElement;
tablist.addEventListener("keydown", (e) => {
  const idx = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (idx === -1) return;
  let next = -1;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = (idx + 1) % tabs.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = (idx - 1 + tabs.length) % tabs.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  activateTab(tabs[next]);
});

// Wire auto-save listeners (Connection + Agent fields persist on change).
initAutoSave();

// ─── About tab — version from the manifest ───────────────────────────────────

try {
  const aboutVersion = document.getElementById("aboutVersion");
  if (aboutVersion) aboutVersion.textContent = chrome.runtime.getManifest().version;
} catch {
  /* manifest unavailable — version stays as the static fallback text */
}
