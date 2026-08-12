/**
 * Mini axe-style accessibility rule engine for jsdom-level assertions.
 *
 * Not a replacement for axe-core in a real browser; it covers the rules that
 * are meaningful at the jsdom DOM level for this product's critical flows:
 *
 * | rule                | severity | check                                                    |
 * |---------------------|----------|----------------------------------------------------------|
 * | interactive-name    | serious  | buttons/links/selects have a non-empty accessible name   |
 * | label-associated    | serious  | inputs/selects/textareas have an accessible label        |
 * | aria-refs-valid     | serious  | aria-labelledby/describedby/controls resolve to an id    |
 * | hidden-focusable    | serious  | no focusable inside hidden/aria-hidden subtrees          |
 * | button-type         | moderate | buttons inside a <form> declare type=                    |
 * | duplicate-id        | moderate | ids are unique                                           |
 * | live-region         | moderate | expected live regions exist (status + alert)             |
 * | heading-order       | moderate | h1..h6 levels do not skip a level                        |
 *
 * Gate: critical flows must have ZERO serious/critical findings.
 */

export type A11ySeverity = "critical" | "serious" | "moderate" | "minor";

export interface A11yViolation {
  rule: string;
  severity: A11ySeverity;
  /** A readable element descriptor, e.g. `button#sendBtn`. */
  target: string;
  message: string;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className
    ? `.${el.className.trim().split(/\s+/)[0]}`
    : "";
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

/** Escape an id for use inside a CSS attribute selector (jsdom lacks CSS.escape). */
function escapeCssIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function accessibleName(el: Element): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    return labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el.id) {
      const lbl = document.querySelector<HTMLLabelElement>(`label[for="${escapeCssIdent(el.id)}"]`);
      if (lbl?.textContent?.trim()) return lbl.textContent.trim();
    }
    if (el.closest("label")?.textContent?.trim()) return el.closest("label")!.textContent!.trim();
    if (el.getAttribute("title")) return el.getAttribute("title")!.trim();
  }
  return (el.textContent ?? "").trim();
}

function isHidden(el: Element): boolean {
  // `.is-hidden` = display:none (defined in options.css) — treated as hidden.
  return (
    (el as HTMLElement).hidden ||
    el.hasAttribute("hidden") ||
    el.classList.contains("is-hidden") ||
    el.getAttribute("aria-hidden") === "true" ||
    el.closest(".is-hidden, [aria-hidden='true']") !== null
  );
}

/** Run all rules against `root` (the full document by default). */
export function runA11yRules(
  root: Document | HTMLElement = document,
  opts: { requireLiveRegions?: { statusId?: string; alertId?: string } } = {},
): A11yViolation[] {
  const doc = root instanceof Document ? root : root.ownerDocument ?? document;
  const scope: ParentNode = root instanceof Document ? root.body : root;
  const violations: A11yViolation[] = [];

  // ── serious: interactive-name ───────────────────────────────────────────
  const namedControls = scope.querySelectorAll<HTMLElement>(
    "button, a[href], select, input[type='button'], input[type='submit'], input[type='checkbox'], input[type='radio']",
  );
  for (const el of namedControls) {
    if (isHidden(el)) continue;
    if (el instanceof HTMLInputElement && el.type === "button" && (el.value || el.title)) continue;
    if (!accessibleName(el)) {
      violations.push({
        rule: "interactive-name",
        severity: "serious",
        target: describe(el),
        message: "Interactive control has no accessible name (text, aria-label, or aria-labelledby).",
      });
    }
  }

  // ── serious: label-associated ───────────────────────────────────────────
  const labelled = scope.querySelectorAll<HTMLElement>(
    "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='checkbox']):not([type='radio']), select, textarea",
  );
  for (const el of labelled) {
    if (isHidden(el)) continue;
    if (!accessibleName(el)) {
      violations.push({
        rule: "label-associated",
        severity: "serious",
        target: describe(el),
        message: "Form control has no programmatic label (label[for], wrapping label, aria-label, or aria-labelledby).",
      });
    }
  }

  // ── serious: aria-refs-valid ────────────────────────────────────────────
  for (const el of scope.querySelectorAll<HTMLElement>("[aria-labelledby], [aria-describedby], [aria-controls]")) {
    for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls"] as const) {
      const refs = el.getAttribute(attr);
      if (!refs) continue;
      for (const ref of refs.split(/\s+/)) {
        if (ref && !doc.getElementById(ref)) {
          violations.push({
            rule: "aria-refs-valid",
            severity: "serious",
            target: describe(el),
            message: `${attr} references missing id "#${ref}".`,
          });
        }
      }
    }
  }

  // ── serious: hidden-focusable ───────────────────────────────────────────
  // Only `aria-hidden="true"` subtrees are flagged: aria-hidden does NOT
  // prevent keyboard focus, so focusable content inside it is a real trap.
  // The `hidden` attribute / `.is-hidden` class ARE display:none in browsers,
  // so their contents are genuinely unfocusable and not violations.
  for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (
      el.getAttribute("aria-hidden") === "true" ||
      el.closest("[aria-hidden='true']") !== null
    ) {
      violations.push({
        rule: "hidden-focusable",
        severity: "serious",
        target: describe(el),
        message: "Focusable element is inside an aria-hidden subtree (aria-hidden does not block focus).",
      });
    }
  }

  // ── moderate: button-type ───────────────────────────────────────────────
  for (const el of scope.querySelectorAll<HTMLButtonElement>("button")) {
    if (isHidden(el)) continue;
    if (el.closest("form") && !el.getAttribute("type")) {
      violations.push({
        rule: "button-type",
        severity: "moderate",
        target: describe(el),
        message: "Button inside a <form> has no type attribute (may submit unexpectedly).",
      });
    }
  }

  // ── moderate: duplicate-id ──────────────────────────────────────────────
  const seen = new Set<string>();
  for (const el of scope.querySelectorAll<HTMLElement>("[id]")) {
    const id = el.id;
    if (seen.has(id)) {
      violations.push({
        rule: "duplicate-id",
        severity: "moderate",
        target: describe(el),
        message: `Duplicate id "${id}".`,
      });
    }
    seen.add(id);
  }

  // ── moderate: live-region ───────────────────────────────────────────────
  const { statusId, alertId } = opts.requireLiveRegions ?? {};
  if (statusId && !doc.getElementById(statusId)) {
    violations.push({
      rule: "live-region",
      severity: "moderate",
      target: "document",
      message: `Polite live region #${statusId} is missing.`,
    });
  }
  if (alertId && !doc.getElementById(alertId)) {
    violations.push({
      rule: "live-region",
      severity: "moderate",
      target: "document",
      message: `Assertive live region #${alertId} is missing.`,
    });
  }

  // ── moderate: heading-order ─────────────────────────────────────────────
  let lastLevel = 0;
  for (const el of scope.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    if (isHidden(el)) continue;
    const level = Number(el.tagName[1]);
    if (lastLevel && level > lastLevel + 1) {
      violations.push({
        rule: "heading-order",
        severity: "moderate",
        target: describe(el),
        message: `Heading level jumps from h${lastLevel} to h${level}.`,
      });
    }
    lastLevel = level;
  }

  return violations;
}

export function seriousViolations(violations: A11yViolation[]): A11yViolation[] {
  return violations.filter((v) => v.severity === "critical" || v.severity === "serious");
}

