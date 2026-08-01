import { sanitizeForLog } from "../constants";

export const sanitizeLabel = sanitizeForLog;

export function formatOptionList(opts: Element[], n = 8): string {
  return opts
    .slice(0, n)
    .map((o, i) => `${i}:${sanitizeLabel((o.textContent || "").trim() || (o as HTMLOptionElement).value || "")}`)
    .join(", ");
}

let _layoutEnginePresent: boolean | null = null;
function layoutEnginePresent(): boolean {
  if (_layoutEnginePresent === null) {
    if (typeof document === "undefined") {
      _layoutEnginePresent = false;
    } else {
      const root = document.documentElement;
      const r = root.getBoundingClientRect();
      _layoutEnginePresent = r.width > 0 || r.height > 0;
    }
  }
  return _layoutEnginePresent;
}

function isVisible(el: Element): boolean {
  if (typeof getComputedStyle !== "function") return true;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
  return !layoutEnginePresent();
}

export function collectDropdownOptions(trigger: Element): HTMLElement[] {
  const visible = (els: NodeListOf<Element> | Element[]) =>
    (Array.from(els) as HTMLElement[]).filter(isVisible);

  const subtree = visible(trigger.querySelectorAll('[role="option"]'));
  if (subtree.length > 0) return subtree;

  const triggerId = trigger.getAttribute("id");
  if (triggerId && /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(triggerId)) {
    const labelled = document.querySelector<HTMLElement>(
      `[role="listbox"][aria-labelledby~="${triggerId}"]`,
    );
    if (labelled && isVisible(labelled)) {
      const opts = visible(labelled.querySelectorAll('[role="option"]'));
      if (opts.length > 0) return opts;
    }
  }

  const openListbox = (
    Array.from(document.querySelectorAll('[role="listbox"]')) as HTMLElement[]
  ).find(isVisible);
  if (openListbox) {
    const opts = visible(openListbox.querySelectorAll('[role="option"]'));
    if (opts.length > 0) return opts;
  }

  return visible(document.querySelectorAll('[role="option"]')).slice(0, 100);
}
