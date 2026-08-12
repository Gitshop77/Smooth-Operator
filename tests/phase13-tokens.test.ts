/**
 * Phase 13 — design tokens: WCAG AA contrast + CSS↔TS sync + alias coverage.
 *
 * - Every pair in `ocContrastPairs` must reach ≥4.5:1 (normal text) in both
 *   themes, with rgba backgrounds blended over the app surface.
 * - `tokens.css` and `tokens.ts` must agree on the full color set (dark +
 *   light), so the runtime stylesheet and the tested contract cannot drift.
 * - Every `var(--oc-*)` referenced by the surface/component stylesheets must
 *   be defined in `tokens.css` (no undefined custom properties).
 * - Legacy `--cw-*` names must still resolve (cutover compatibility), and the
 *   surface stylesheets must no longer reference them.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { ocTokens, ocContrastPairs } from "../src/extension/tokens";
import { blendOver, contrastOnSolid, contrastRatio, parseCssColor } from "./helpers/color";
import * as csstree from "css-tree";

const tokensCss = readFileSync("src/extension/tokens.css", "utf8");
const sidepanelCss = readFileSync("src/extension/sidepanel.css", "utf8");
const optionsCss = readFileSync("src/extension/options.css", "utf8");
const componentsCss = readFileSync("src/extension/components.css", "utf8");

const SURFACE_CSS = [sidepanelCss, optionsCss, componentsCss];

/** Extract `--name: value;` declarations from a CSS fragment (last wins). */
function extractVars(css: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:^|\s)(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    map.set(m[1], m[2].trim().replace(/\s+/g, " "));
  }
  return map;
}

function normalize(v: string): string {
  return v.trim().replace(/\s+/g, " ").replace(/,\s+/g, ",");
}

/** CamelCase tokens.ts key → CSS custom property name (surface keys use `-bg-`). */
const BG_KEYS = new Set(["app", "panel", "raised", "input", "scrim"]);
function cssVarFor(key: string): string {
  const body = BG_KEYS.has(key) ? `bg-${key}` : key;
  return "--oc-prim-" + body.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

/** Resolve `var(--x)` chains through the definition map (depth-bounded). */
function resolveVars(map: Map<string, string>, name: string, depth = 0): string {
  const value = map.get(name);
  if (value === undefined || depth > 8) return value ?? "";
  const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return m ? resolveVars(map, m[1], depth + 1) : value;
}

describe("Phase 13 — WCAG AA contrast (both themes)", () => {
  test("every text/background pair reaches ≥4.5:1 (WCAG AA normal text)", () => {
    const failures: string[] = [];
    for (const pair of ocContrastPairs) {
      const theme = ocTokens[pair.theme];
      const fg = theme[pair.fg as keyof typeof theme] as string;
      const bgRaw = theme[pair.bg as keyof typeof theme] as string;
      // Subtle backgrounds are rgba blended over the app surface FIRST (the
      // tokens.ts contract); only then is the ratio computed — this is what
      // catches light warning #B45309 on rgba(217,119,6,.08) over #F7F8FB
      // (4.36:1 < 4.5) that the old test missed.
      const ratio = bgRaw.startsWith("#")
        ? contrastOnSolid(fg, bgRaw)
        : contrastRatio(parseCssColor(fg), blendOver(parseCssColor(bgRaw), parseCssColor(theme.app)));
      if (ratio < 4.5) {
        failures.push(`${pair.name} (${pair.theme}): ${ratio.toFixed(2)}:1 < 4.5`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every pair references real tokens in both themes", () => {
    for (const pair of ocContrastPairs) {
      const theme = ocTokens[pair.theme];
      expect(theme[pair.fg as keyof typeof theme], `${pair.theme}.${pair.fg}`).toBeDefined();
      expect(theme[pair.bg as keyof typeof theme], `${pair.theme}.${pair.bg}`).toBeDefined();
    }
    // The text-bearing colors must all appear as foregrounds somewhere.
    const textTokens = ["textPrimary", "textSecondary", "textTertiary", "textOnAccent",
      "accentText", "success", "warning", "danger", "info"];
    for (const themeName of ["dark", "light"] as const) {
      const used = new Set(ocContrastPairs.filter((p) => p.theme === themeName).map((p) => p.fg));
      for (const t of textTokens) {
        expect(used.has(t), `${themeName}.${t} never asserted as text`).toBe(true);
      }
    }
  });

  test("text-on-accent and dangerStrong passes with white text (buttons)", () => {
    for (const themeName of ["dark", "light"] as const) {
      const theme = ocTokens[themeName];
      const accent = contrastOnSolid(theme.textOnAccent, theme.accent);
      const dangerBtn = contrastOnSolid(theme.textOnAccent, theme.dangerStrong);
      expect(accent, `${themeName} white on accent`).toBeGreaterThanOrEqual(4.5);
      expect(dangerBtn, `${themeName} white on danger button`).toBeGreaterThanOrEqual(4.5);
    }
  });
});


describe("Phase 13 — tokens.css ↔ tokens.ts sync", () => {
  test("dark + light color tokens match the stylesheet exactly", () => {
    const LIGHT_MARKER = "@media (prefers-color-scheme: light) {";
    const darkVars = extractVars(tokensCss.slice(0, tokensCss.indexOf(LIGHT_MARKER)));
    const lightStart = tokensCss.indexOf(LIGHT_MARKER);
    const lightEnd = tokensCss.lastIndexOf("}");
    const lightVars = extractVars(tokensCss.slice(lightStart, lightEnd));

    const mismatches: string[] = [];
    for (const themeName of ["dark", "light"] as const) {
      const theme = ocTokens[themeName];
      const vars = themeName === "dark" ? darkVars : lightVars;
      for (const [key, tsValue] of Object.entries(theme)) {
        const cssValue = vars.get(cssVarFor(key));
        if (cssValue === undefined) {
          mismatches.push(`${themeName} --oc-prim-${key}: missing in CSS`);
          continue;
        }
        if (normalize(cssValue) !== normalize(tsValue)) {
          mismatches.push(
            `${themeName} --oc-prim-${key}: CSS "${normalize(cssValue)}" ≠ TS "${normalize(tsValue)}"`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("spacing/radius/type/motion/elevation/focus spot-checks match", () => {
    const allVars = extractVars(tokensCss);
    const check = (cssName: string, tsValue: string) => {
      const resolved = resolveVars(allVars, cssName);
      expect(normalize(resolved), cssName).toBe(normalize(tsValue));
    };
    check("--oc-label-gap", "6px");
    check("--oc-field-gap", "18px");
    check("--oc-section-gap", "24px");
    check("--oc-control-pad", "10px 12px");
    check("--oc-card-pad", "16px 20px");
    check("--oc-radius-sm", "6px");
    check("--oc-radius-md", "10px");
    check("--oc-radius-lg", "16px");
    check("--oc-text-base", "13px");
    check("--oc-duration-fast", "120ms");
    check("--oc-elevation-2", "0 6px 20px rgba(0, 0, 0, 0.38)");
    check("--oc-focus-ring-width", "2px");
    check("--oc-focus-ring-offset", "2px");
  });
});

describe("Phase 13 — custom property integrity", () => {
  test("every var(--oc-*) referenced by the stylesheets is defined in tokens.css", () => {
    const defined = extractVars(tokensCss);
    const referenced = new Set<string>();
    const re = /var\((--oc-[\w-]+)/g;
    for (const css of [...SURFACE_CSS, tokensCss]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(css)) !== null) referenced.add(m[1]);
    }
    const missing = Array.from(referenced).filter((v) => !defined.has(v));
    expect(missing).toEqual([]);
  });

  test("semantic aliases resolve through primitives (no alias-to-alias loops that escape)", () => {
    const allVars = extractVars(tokensCss);
    for (const alias of [
      "--oc-surface-app", "--oc-text-primary", "--oc-accent", "--oc-status-danger-strong", "--oc-btn-primary-bg",
    ]) {
      // Follow the var() chain; it must terminate in a literal color value.
      expect(resolveVars(allVars, alias), alias).toMatch(/^(#|rgba\()/);
    }
  });

  test("legacy --cw-*/--gap-*/--pad-* aliases still resolve in tokens.css", () => {
    const allVars = extractVars(tokensCss);
    for (const legacy of [
      "--cw-void", "--cw-surface", "--cw-raised", "--cw-text", "--cw-muted", "--cw-dim",
      "--cw-accent", "--cw-accent-contrast", "--cw-success", "--cw-danger", "--cw-warn",
      "--cw-ring", "--cw-radius", "--cw-gap-field", "--cw-pad-card", "--cw-sans", "--cw-ease",
      "--gap-label", "--pad-input",
    ]) {
      expect(allVars.get(legacy), `${legacy} alias`).toContain("var(--oc-");
    }
  });

  test("surface stylesheets reference only the new semantic layer (cutover complete)", () => {
    const leftover = SURFACE_CSS
      .flatMap((css, i) => Array.from(css.matchAll(/--cw-[\w-]+|--gap-[\w-]+|--pad-[\w-]+/g)).map((m) => `${i}:${m[0]}`));
    expect(leftover).toEqual([]);
  });

  test("both surfaces import the shared token + component layers", () => {
    expect(sidepanelCss).toContain('@import url("tokens.css");');
    expect(sidepanelCss).toContain('@import url("components.css");');
    expect(optionsCss).toContain('@import url("tokens.css");');
    expect(optionsCss).toContain('@import url("components.css");');
  });
});

describe("Phase 13 — components.css parse structure + AA hover/render contract (B1/M1/M2 regressions)", () => {
  /** Collect top-level rule selectors via a css-tree walk of the stylesheet. */
  function topLevelSelectors(css: string): Set<string> {
    const ast = csstree.parse(css, { positions: false });
    const selectors = new Set<string>();
    if (!ast || ast.type !== "StyleSheet" || !ast.children) return selectors;
    for (const child of ast.children) {
      if (child.type !== "Rule") continue; // Atrule (@media) children are depth-1, not top-level
      csstree.walk(child.prelude, (node) => {
        if (node.type === "Selector") {
          selectors.add(csstree.generate(node).trim());
        }
      });
    }
    return selectors;
  }

  test("B1: shared component families exist as top-level rules in components.css (no nesting leak)", () => {
    const top = topLevelSelectors(componentsCss);
    for (const selector of [
      ".btn", ".btn-primary", ".btn-danger", ".btn-ghost", ".btn-sm", ".btn-block",
      ".notice", ".notice-title", ".notice-error", ".notice-warning", ".notice-success", ".notice-info",
      ".progress-track", ".progress-bar", ".progress-label",
      ".empty-state", ".empty-state-title", ".empty-state-hint",
      ".field", ".field-label", ".field-hint", ".field-error",
      ".dialog", ".dialog-header", ".dialog-title", ".dialog-body", ".dialog-footer",
    ]) {
      expect(top.has(selector), `components.css must contain a top-level ${selector}`).toBe(true);
    }
  });

  test("M2: hover fills referenced by the shared layer keep white text ≥4.5:1 and never revert to the uncorrected danger fill", () => {
    // The hover tokens are already enforced through ocContrastPairs; this test
    // asserts the RENDER paths actually use those tokens (not a stray literal).
    // `[^}]*` keeps the match inside the rule's own block.
    expect(componentsCss).toMatch(/\.btn-primary:hover[^{]*\{[^}]*var\(--oc-accent-hover\)/);
    expect(componentsCss).toMatch(/\.btn-danger:hover[^{]*\{[^}]*var\(--oc-status-danger-strong\)/);
    // No rule may paint white text on the uncorrected danger fill.
    expect(componentsCss).not.toMatch(/\.btn-danger:hover[^{]*\{[^}]*var\(--oc-status-danger\)/);
  });

  test("M1: the AA-corrected warning token reaches the light-theme warning surfaces (takeover banner, vision badges, notices)", () => {
    // The takeover banner (side panel), vision-status badges (status.ts) and
    // .notice-warning (components.css) all paint --oc-status-warning text on
    // --oc-status-warning-subtle. The corrected token must be what they use.
    expect(sidepanelCss).toMatch(/\.takeover-title[^{]*\{[^}]*var\(--oc-status-warning\)/);
    expect(componentsCss).toMatch(/\.notice-warning[^{]*\{[^}]*var\(--oc-status-warning\)/);
    const statusTs = readFileSync("src/extension/options/status.ts", "utf8");
    // compiling + warning badges use warning text on the subtle background.
    expect(statusTs).toContain('color: "var(--oc-status-warning)"');
    expect(statusTs).toContain('bg: "var(--oc-status-warning-subtle)"');
    // And the light-theme value itself is the AA-corrected #A1420A in BOTH the
    // runtime stylesheet and the TS mirror (drift guard).
    expect(tokensCss).toContain("--oc-prim-warning:        #A1420A");
    expect(ocTokens.light.warning).toBe("#A1420A");
  });

  test("M2: dark accent-hover is AA-safe in both the stylesheet and the TS mirror", () => {
    expect(tokensCss).toContain("--oc-prim-accent-hover:   #5A49D6");
    expect(ocTokens.dark.accentHover).toBe("#5A49D6");
    expect(contrastRatio(ocTokens.dark.textOnAccent, ocTokens.dark.accentHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ocTokens.light.textOnAccent, ocTokens.light.accentHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ocTokens.dark.textOnAccent, ocTokens.dark.dangerStrong)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ocTokens.light.textOnAccent, ocTokens.light.dangerStrong)).toBeGreaterThanOrEqual(4.5);
  });

  test("M3: the focus ring is a non-text indicator ≥3:1 vs the app surface in both themes", () => {
    expect(contrastRatio(ocTokens.dark.focusRing, ocTokens.dark.app)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ocTokens.light.focusRing, ocTokens.light.app)).toBeGreaterThanOrEqual(3);
    // Solid accent-strong per theme in the runtime stylesheet (drift guard).
    expect(tokensCss).toContain("--oc-prim-focus-ring: #8F82F5");
    expect(tokensCss).toContain("--oc-prim-focus-ring: #4C3FCB");
  });

  test("M5: announce() re-announces an identical message by clearing the region first", async () => {
    document.body.innerHTML = '<div id="statusMessage" role="status" aria-live="polite"></div>';
    const { announce } = await import("../src/extension/accessibility");
    announce("Settings saved — mode: standard");
    const region = document.getElementById("statusMessage") as HTMLElement;
    expect(region.textContent).toBe("Settings saved — mode: standard");

    // Capture the DOM mutations of a repeated IDENTICAL announcement: it must
    // clear the region before re-populating (screen readers skip an unchanged
    // textContent), so at least two mutations are observed.
    const cleared: string[] = [];
    const mo = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") cleared.push(region.textContent ?? "");
      }
    });
    mo.observe(region, { childList: true, characterData: true, subtree: true });
    announce("Settings saved — mode: standard");
    await new Promise((r) => setTimeout(r, 0)); // let MutationObserver records flush
    mo.disconnect();
    expect(cleared.length).toBeGreaterThanOrEqual(2); // emptied → repopulated
    expect(region.textContent).toBe("Settings saved — mode: standard");
  });
});
