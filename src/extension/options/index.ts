/**
 * options/index.ts — entry point for the Options page logic.
 *
 * Wires the left-rail tab switcher (keyboard-navigable, ARIA-compliant) and
 * imports every options/* submodule to trigger their top-level side effects
 * (form hydration, addEventListener registration, settings load).
 *
 * Tabs switch via JS (no full reload). Each tab has its own ViewHeader-style
 * title + subtitle baked into options.html; switching just shows/hides panels.
 *
 * NOTE: i18n / localization of these UI strings is currently OUT OF SCOPE —
 * all user-facing text is hardcoded English.
 */

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

// Lazily render dynamic tab content on first activation. Hoisted to module
// scope so it is built once, not re-allocated on every tab switch.
//
// The 5-tab consolidation maps old renderers into parent tabs:
// - "agent" sub-tabs: prompts → loadPrompts
// - "storage" sub-tabs: secrets → renderSecrets
// - "automation" sub-tabs: schedule → renderSchedule, tools → renderTools,
//   skills → renderSkills, notify → loadNotifications
// - "history" sub-tabs: history → renderHistory
const rendered = new Set<string>();

const renderers: Record<string, () => void | Promise<void>> = {
  agent: loadPrompts,
  storage: renderSecrets,
  automation: async () => {
    await Promise.all([
      renderSchedule(),
      renderTools(),
      renderSkills(),
      loadNotifications(),
    ]);
  },
  history: renderHistory,
};

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
    const isActive = c.dataset.tab === target;
    c.classList.toggle("active", isActive);
    c.hidden = !isActive;
 // L12: only the active panel is in the tab order.
    c.tabIndex = isActive ? 0 : -1;
  });
 // Lazily render dynamic tab content on first activation. A renderer that
 // reads chrome.storage.local can reject (quota/disabled/policy); catch it so
 // a transient failure surfaces as a warning instead of an unhandled rejection.
  if (!rendered.has(target) && renderers[target]) {
    rendered.add(target);
    Promise.resolve(renderers[target]()).catch((err) => {
      rendered.delete(target);
      console.warn("[options] tab renderer failed:", err);
    });
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab, false));
});

// ARIA tablist keyboard navigation (Left/Right/Up/Down/Home/End).
// Null-guard: if #tablist is absent from the markup, skip wiring rather than
// throwing at module-eval and aborting the rest of options init (auto-save
// wiring, tab renderers, about-version). `document.getElementById` (not the
// throwing `$` helper) so the guard actually works.
const tablist = document.getElementById("tablist");
if (tablist) tablist.addEventListener("keydown", (e) => {
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
  /* manifest unavailable — version stays empty */
}

// Activate the default tab on load so inactive panels receive the `hidden`
// attribute even if the stylesheet fails to load (panels otherwise
// rely solely on the CSS `.active { display }` rule and would remain in the
// accessibility tree / focusable if the CSS never arrives).
const initialTab = document.querySelector(".tab.active") as HTMLButtonElement | null;
if (initialTab) activateTab(initialTab, false);
