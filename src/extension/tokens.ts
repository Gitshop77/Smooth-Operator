/**
 * Design tokens — TypeScript mirror of `tokens.css` (single source for the
 * automated contrast/consistency checks in `tests/design-tokens.test.ts`).
 *
 * Values here MUST match `tokens.css` (the runtime source of truth). The test
 * suite cross-checks a subset of key values against the parsed stylesheet so
 * the two layers cannot silently drift.
 *
 * AA contract (WCAG 2.1):
 * - Every text/background pair listed in `ocContrastPairs` must reach ≥4.5:1
 *   (normal text). Status colors are chosen so they also pass on their
 *   `*-subtle` backgrounds (vision badge, test result, takeover banner).
 * - `--oc-accent-text` is the AA-corrected accent FOR TEXT; `--oc-accent` is
 *   the fill/border accent (non-text contrast ≥3:1 satisfies 1.4.11).
 * - Several legacy values were intentionally corrected upward for AA
 *   (dark `--cw-dim` #646B7A→#8890A3, light success #16A34A→#166534,
 *   light warning #D97706→#B45309→#A1420A (blended-subtle pair must stay
 *   ≥4.5:1), light danger #DC2626→#B91C1C,
 *   dark danger-button fill #F87171→#DC2626) — see PHASE_EVIDENCE.md.
 * - Hover fills keep the AA contract too: `.btn-primary:hover` uses
 *   `accentHover` (dark #5A49D6 keeps white text ≥4.5:1) and
 *   `.btn-danger:hover` stays on `dangerStrong` (never reverts to the
 *   uncorrected `danger`), both enforced via `ocContrastPairs`.
 */

export interface OcColorTokens {
  /** Surfaces */
  app: string;
  panel: string;
  raised: string;
  input: string;
  scrim: string;
  /** Borders */
  border: string;
  borderStrong: string;
  /** Text */
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnAccent: string;
  /** Accent */
  accent: string;
  accentHover: string;
  /** AA-corrected accent for text on app/surface/subtle backgrounds. */
  accentText: string;
  /** Accent for small fills/badges on `accentSubtle`. */
  accentStrong: string;
  accentSubtle: string;
  /** Status (text on app/surface/subtle) */
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  warningBorder: string;
  danger: string;
  dangerSubtle: string;
  dangerBorder: string;
  /** Strong danger FILL (buttons): white text must reach ≥4.5:1 on it. */
  dangerStrong: string;
  info: string;
  /** Focus ring (2px outline; non-text indicator). */
  focusRing: string;
}

export const ocTokens: Record<"dark" | "light", OcColorTokens> = {
  dark: {
    app: "#14161C",
    panel: "#1C1F27",
    raised: "#232732",
    input: "#0E1015",
    scrim: "rgba(10, 12, 16, 0.62)",
    border: "#2A2E38",
    borderStrong: "#3A3F4D",
    textPrimary: "#E7E9F0",
    textSecondary: "#9AA0B0",
    textTertiary: "#8890A3",
    textOnAccent: "#FFFFFF",
    accent: "#6C5CE7",
    accentHover: "#5A49D6",
    accentText: "#8F82F5",
    accentStrong: "#8F82F5",
    accentSubtle: "rgba(108, 92, 231, 0.12)",
    success: "#4ADE80",
    successSubtle: "rgba(74, 222, 128, 0.14)",
    warning: "#FBBF24",
    warningSubtle: "rgba(251, 191, 36, 0.10)",
    warningBorder: "rgba(251, 191, 36, 0.28)",
    danger: "#F87171",
    dangerSubtle: "rgba(248, 113, 113, 0.12)",
    dangerBorder: "rgba(248, 113, 113, 0.40)",
    dangerStrong: "#DC2626",
    info: "#60A5FA",
    focusRing: "#8F82F5",
  },
  light: {
    app: "#F7F8FB",
    panel: "#FFFFFF",
    raised: "#EEF0F5",
    input: "#F0F1F5",
    scrim: "rgba(10, 12, 16, 0.45)",
    border: "#E2E5EC",
    borderStrong: "#D2D6E0",
    textPrimary: "#1A1D26",
    textSecondary: "#5C6273",
    textTertiary: "#565E6E",
    textOnAccent: "#FFFFFF",
    accent: "#6C5CE7",
    accentHover: "#5A49D6",
    accentText: "#5A49D6",
    accentStrong: "#4C3FCB",
    accentSubtle: "rgba(108, 92, 231, 0.12)",
    success: "#166534",
    successSubtle: "rgba(22, 163, 74, 0.12)",
    warning: "#A1420A",
    warningSubtle: "rgba(217, 119, 6, 0.08)",
    warningBorder: "rgba(217, 119, 6, 0.25)",
    danger: "#B91C1C",
    dangerSubtle: "rgba(220, 38, 38, 0.10)",
    dangerBorder: "rgba(220, 38, 38, 0.40)",
    dangerStrong: "#B91C1C",
    info: "#2563EB",
    focusRing: "#4C3FCB",
  },
};


/**
 * AA pairs asserted by the test suite for BOTH themes. `bg` may be a hex or an
 * rgba() — rgba is blended over `app` first, mirroring how `*-subtle` colors
 * render on top of the page background.
 */
export const ocContrastPairs: ReadonlyArray<{
  theme: "dark" | "light";
  name: string;
  fg: string;
  bg: string;
}> = [
  // Primary/secondary/tertiary text on every surface they render on.
  { theme: "dark", name: "text-primary / app", fg: "textPrimary", bg: "app" },
  { theme: "dark", name: "text-secondary / app", fg: "textSecondary", bg: "app" },
  { theme: "dark", name: "text-tertiary / app", fg: "textTertiary", bg: "app" },
  { theme: "dark", name: "text-secondary / panel", fg: "textSecondary", bg: "panel" },
  { theme: "dark", name: "text-tertiary / panel", fg: "textTertiary", bg: "panel" },
  { theme: "dark", name: "text-secondary / raised", fg: "textSecondary", bg: "raised" },
  { theme: "dark", name: "text-tertiary / raised", fg: "textTertiary", bg: "raised" },
  { theme: "dark", name: "text-on-accent / accent", fg: "textOnAccent", bg: "accent" },
  { theme: "dark", name: "text-on-accent / dangerStrong", fg: "textOnAccent", bg: "dangerStrong" },
  // Hover fills: `.btn-primary:hover` and `.btn-danger:hover` must keep
  // white text ≥4.5:1 — the hover tokens are enforced exactly like base pairs.
  { theme: "dark", name: "text-on-accent / accent-hover (btn-primary:hover)", fg: "textOnAccent", bg: "accentHover" },
  { theme: "dark", name: "text-on-accent / danger-strong (btn-danger:hover)", fg: "textOnAccent", bg: "dangerStrong" },
  { theme: "dark", name: "accent-text / app", fg: "accentText", bg: "app" },
  { theme: "dark", name: "accent-text / accentSubtle", fg: "accentText", bg: "accentSubtle" },
  { theme: "dark", name: "success / successSubtle", fg: "success", bg: "successSubtle" },
  { theme: "dark", name: "warning / warningSubtle", fg: "warning", bg: "warningSubtle" },
  { theme: "dark", name: "danger / dangerSubtle", fg: "danger", bg: "dangerSubtle" },
  { theme: "dark", name: "success / app", fg: "success", bg: "app" },
  { theme: "dark", name: "warning / app", fg: "warning", bg: "app" },
  { theme: "dark", name: "danger / app", fg: "danger", bg: "app" },
  { theme: "dark", name: "info / app", fg: "info", bg: "app" },
  { theme: "light", name: "text-primary / app", fg: "textPrimary", bg: "app" },
  { theme: "light", name: "text-secondary / app", fg: "textSecondary", bg: "app" },
  { theme: "light", name: "text-tertiary / app", fg: "textTertiary", bg: "app" },
  { theme: "light", name: "text-secondary / panel", fg: "textSecondary", bg: "panel" },
  { theme: "light", name: "text-tertiary / panel", fg: "textTertiary", bg: "panel" },
  { theme: "light", name: "text-secondary / raised", fg: "textSecondary", bg: "raised" },
  { theme: "light", name: "text-tertiary / raised", fg: "textTertiary", bg: "raised" },
  { theme: "light", name: "text-on-accent / accent", fg: "textOnAccent", bg: "accent" },
  { theme: "light", name: "text-on-accent / dangerStrong", fg: "textOnAccent", bg: "dangerStrong" },
  { theme: "light", name: "text-on-accent / accent-hover (btn-primary:hover)", fg: "textOnAccent", bg: "accentHover" },
  { theme: "light", name: "text-on-accent / danger-strong (btn-danger:hover)", fg: "textOnAccent", bg: "dangerStrong" },
  { theme: "light", name: "accent-text / app", fg: "accentText", bg: "app" },
  { theme: "light", name: "accent-text / accentSubtle", fg: "accentText", bg: "accentSubtle" },
  { theme: "light", name: "success / successSubtle", fg: "success", bg: "successSubtle" },
  { theme: "light", name: "warning / warningSubtle", fg: "warning", bg: "warningSubtle" },
  { theme: "light", name: "danger / dangerSubtle", fg: "danger", bg: "dangerSubtle" },
  { theme: "light", name: "success / app", fg: "success", bg: "app" },
  { theme: "light", name: "warning / app", fg: "warning", bg: "app" },
  { theme: "light", name: "danger / app", fg: "danger", bg: "app" },
  { theme: "light", name: "info / app", fg: "info", bg: "app" },
];
