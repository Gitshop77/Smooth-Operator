/**
 * Agent modes — the 3-tier permission system that controls what the agent
 * can do.
 *
 *   RESTRICTED    — current tab only. No new tabs, no navigation to new URLs.
 *                   Safe for "fill this form" tasks.
 *   STANDARD      — current tab + open new tabs + navigate. Default.
 *                   The agent can browse freely but can't do destructive things.
 *   FULL_AGENTIC  — everything: open/close tabs, navigate, execute JS, upload,
 *                   download, run for hours. Power-user mode.
 */

/** The 3 supported permission tiers. */
export type AgentMode = "restricted" | "standard" | "full_agentic";

/** Per-mode permission + step-budget configuration. */
export interface ModeConfig {
  /** Can open new tabs. */
  canOpenTabs: boolean;
  /** Can close tabs. */
  canCloseTabs: boolean;
  /** Can navigate to a new URL (different origin). */
  canNavigate: boolean;
  /** Can switch to another tab. */
  canSwitchTabs: boolean;
  /** Can execute arbitrary JavaScript (evaluate action). */
  canExecuteJs: boolean;
  /** Can upload files. */
  canUploadFiles: boolean;
  /** Can download files / save as PDF. */
  canDownloadFiles: boolean;
  /** Max steps before forced stop. */
  maxSteps: number;
  /** Action types that require explicit user confirmation before executing. */
  confirmRequired: readonly string[];
}

/**
 * Mode → config lookup. Keys correspond 1:1 with {@link AgentMode}.
 *
 * `readonly` — the mode table is a module-level constant that must not be
 * mutated at runtime (a stray `MODE_CONFIGS.restricted.canExecuteJs = true`
 * would silently grant the agent eval permission in restricted mode).
 */
export const MODE_CONFIGS = {
  restricted: {
    canOpenTabs: false,
    canCloseTabs: false,
    canNavigate: false,
    canSwitchTabs: false,
    canExecuteJs: false,
    canUploadFiles: false,
    canDownloadFiles: false,
    maxSteps: 30,
    // `done` is intentionally not in the confirm-required list — it's a
    // terminal action (ends the run) rather than a destructive page mutation,
    // and the user already clicked "Run" to start the agent.
    confirmRequired: [],
  },
  standard: {
    canOpenTabs: true,
    canCloseTabs: true,
    canNavigate: true,
    canSwitchTabs: true,
    canExecuteJs: false,
    canUploadFiles: false,
    canDownloadFiles: false,
    maxSteps: 100,
    confirmRequired: ["evaluate", "upload_file", "save_as_pdf"],
  },
  full_agentic: {
    canOpenTabs: true,
    canCloseTabs: true,
    canNavigate: true,
    canSwitchTabs: true,
    canExecuteJs: true,
    canUploadFiles: true,
    canDownloadFiles: true,
    maxSteps: 500,
    confirmRequired: [],
  },
} as const satisfies Record<AgentMode, ModeConfig>;

/** Result of a mode-policy check. */
export interface ActionPolicyResult {
  /** Whether the action is permitted under the mode. */
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
}

/** Known action types that don't require per-mode gating — allowed in every mode. */
const UNGATED_ACTION_TYPES = [
  "click",
  "input",
  "select_dropdown",
  "dropdown_options",
  "scroll",
  "send_keys",
  "hover",
  "press_and_hold",
  "go_back",
  "wait",
  "find_text",
  "find_elements",
  "extract",
  "done",
  "search",
  "search_page",
  // User-interaction actions: not page mutations, safe in every mode.
  "ask_human",
  "takeover",
  "verify",
  // Pure-lookup action: pulls a skill body from the registry, no DOM access,
  // no page mutation. Safe in every mode (including restricted).
  "load_skill",
  // JS-dialog actions: accept / dismiss / inspect / type-into the currently-open
  // alert/confirm/prompt. The auto-dismiss popup-handler has already cleared the
  // dialog from the page; these actions just inspect + acknowledge the queued
  // metadata. No page mutation, no tab-level API access — safe in every mode
  // (including restricted). WITHOUT these entries the default fail-closed branch
  // blocked every alert_* action in every mode, so the agent could never
  // interact with native JS dialogs even when one was open.
  "alert_accept",
  "alert_dismiss",
  "alert_get_text",
  "alert_send_keys",
  // Vision detection: read-only observation (like find_elements), no page
  // mutation. Safe in every mode including restricted.
  "detect_visual",
] as const;

/**
 * Check if an action type is allowed in the given mode.
 *
 * - `navigate` requires `canNavigate` OR `canOpenTabs` (a new-tab navigation
 *   is permitted whenever tab-opening is).
 * - `save_as_pdf` and `screenshot` are gated by `canDownloadFiles` (was:
 *   `canDownloadFiles && mode !== "restricted"` — the mode special-case was
 *   redundant since restricted mode already has `canDownloadFiles: false`).
 * - All other actions are gated by their corresponding `can*` flag.
 * - Known-but-ungated actions (click, input, scroll, etc.) are allowed in
 *   every mode.
 * - Unknown action types are FAIL-CLOSED — the executor will surface a
 *   "not implemented" error, but a typo or future action type added without
 *   a matching case here can't silently bypass mode enforcement.
 */
export function checkActionAllowed(actionType: string, mode: AgentMode): ActionPolicyResult {
  const config = MODE_CONFIGS[mode];
  switch (actionType) {
    case "navigate":
      if (!config.canNavigate && !config.canOpenTabs) {
        return { allowed: false, reason: `Navigation is not allowed in ${mode} mode` };
      }
      return { allowed: true };
    case "switch_tab":
      if (!config.canSwitchTabs) {
        return { allowed: false, reason: `Tab switching is not allowed in ${mode} mode` };
      }
      return { allowed: true };
    case "close_tab":
      if (!config.canCloseTabs) {
        return { allowed: false, reason: `Closing tabs is not allowed in ${mode} mode` };
      }
      return { allowed: true };
    case "evaluate":
      if (!config.canExecuteJs) {
        return { allowed: false, reason: `JavaScript execution is not allowed in ${mode} mode` };
      }
      return { allowed: true };
    case "upload_file":
      if (!config.canUploadFiles) {
        return { allowed: false, reason: `File upload is not allowed in ${mode} mode` };
      }
      return { allowed: true };
    case "save_as_pdf":
    case "screenshot":
      // Gate on the capability flag alone (no `mode === "restricted"`
      // special-case) — restricted mode already has `canDownloadFiles: false`,
      // so the redundant mode check would let a misconfigured mode silently
      // bypass the download block.
      if (!config.canDownloadFiles) {
        return { allowed: false, reason: `Downloads are not allowed in ${mode} mode` };
      }
      return { allowed: true };
    default:
      // Explicit allow-list for known-but-ungated action types.
      if ((UNGATED_ACTION_TYPES as readonly string[]).includes(actionType)) {
        return { allowed: true };
      }
      // Fail-closed for unknown action types — the executor will surface a
      // "not implemented" error, but we don't want a typo (or a future action
      // type added to the executor without a matching case here) to silently
      // bypass mode enforcement.
      return { allowed: false, reason: `Action "${actionType}" is not allowed in ${mode} mode` };
  }
}

/**
 * Check if an action type requires user confirmation before executing.
 * Returns `true` if the action's type appears in the mode's `confirmRequired`
 * list.
 */
export function requiresConfirmation(actionType: string, mode: AgentMode): boolean {
  // `confirmRequired` is typed as a literal tuple (e.g. `["evaluate",
  // "upload_file", "save_as_pdf"]`) by the `as const satisfies` declaration,
  // so `.includes()` rejects a `string` arg. Cast to `readonly string[]` for
  // the runtime check — the literal-precision isn't useful here.
  return (MODE_CONFIGS[mode].confirmRequired as readonly string[]).includes(actionType);
}