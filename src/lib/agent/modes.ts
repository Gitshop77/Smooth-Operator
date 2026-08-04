/**
 * Agent modes — the 3-tier permission system that controls what the agent
 * can do.
 *
 * RESTRICTED — current tab only. No new tabs are opened and the explicit
 * `navigate` / `search` actions (which point the tab at a new URL) are
 * blocked. In-tab navigation caused by a link `click` is permitted (the
 * current tab may still change URL) — it is not a sandbox. Safe for
 * "fill this form" tasks on a page whose links you trust.
 * STANDARD — current tab + open new tabs + navigate. Default.
 * The agent can browse freely but can't do destructive things.
 * FULL_AGENTIC — everything: open/close tabs, navigate, execute JS, upload,
 * download, run for hours. Power-user mode.
 */

/** The 3 supported permission tiers. */
export type AgentMode = "restricted" | "standard" | "full_agentic";

/** Per-mode permission + step-budget configuration. */
interface ModeConfig {
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
  /**
 * Max steps before forced stop for this mode. This is a HARD CAP: the
 * effective step budget handed to the orchestrator MUST be clamped to the
 * active mode's `maxSteps` (e.g. `Math.min(cfgMaxSteps,
 * MODE_CONFIGS[mode].maxSteps)` in `buildLoopDeps`/`startRun`). The
 * user-controlled `chrome.storage.local` `maxSteps` value must never be
 * honored above this cap, or restricted mode (30 steps) could run 1000 steps.
 */
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
    canCloseTabs: true,
    canNavigate: true,
    canSwitchTabs: true,
    canExecuteJs: false,
    canUploadFiles: false,
    canDownloadFiles: false,
    maxSteps: 100,
 // SECURITY: these actions require explicit user confirmation in standard
 // mode. `requiresConfirmation` is a fail-safe gate independent of
 // `checkActionAllowed` — `evaluate`, `upload_file`, and `save_as_pdf` remain
 // HARD-BLOCKED here via `canExecuteJs:false` / `canUploadFiles:false` /
 // `canDownloadFiles:false` (fail-closed before any prompt), but the
 // confirmation flag is still asserted by callers and must report `true` so
 // the gate cannot be bypassed if/when the capability flags change.
 // `set_cookie` / `delete_cookies` / `set_storage` / `clear_storage` are
 // MODE-ALLOWED here (no capability flag gates them) — the confirmation
 // prompt is the primary guard for these destructive state mutations. The
 // domain-allowlist gating on `evaluate` is enforced separately in
 // `evaluate.ts` / `agent-bridge.ts` and is NOT affected by this entry.
    confirmRequired: [
      "evaluate",
      "upload_file",
      "save_as_pdf",
      "screenshot",
      "set_cookie",
      "delete_cookies",
      "set_storage",
      "clear_storage",
    ],
  },
  full_agentic: {
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
interface ActionPolicyResult {
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
  "scroll_to_bottom",
  "send_keys",
  "hover",
  "press_and_hold",
  "go_back",
  "wait",
  // Wait-condition actions: read-only observation of the DOM/URL/network
  // (polling never mutates the page). Safe in every mode including restricted.
  "wait_for_element",
  "wait_for_text",
  "wait_for_url",
  "wait_for_network_idle",
  // Network-log actions: toggle/read a logging ring in the service worker —
  // no page mutation, no tab-level API access. Safe in every mode.
  "enable_network_log",
  "disable_network_log",
  "get_network_log",
  "clear_network_log",
  "getclear_network_log",
  // Console-log actions: same pattern — toggle/read the console-capture ring
  // in the service worker, no page mutation. Safe in every mode.
  "enable_console_log",
  "disable_console_log",
  "get_console_log",
  "clear_console_log",
  "getclear_console_log",
  "find_text",
  "find_elements",
  "list_interactive",
  "get_computed_style",
  "get_page_info",
  "extract",
  "done",
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
  // Challenge detection: read-only DOM classifier (no DOM mutation, no
  // network requests). Safe in every mode including restricted.
  "detect_challenge",
  // Snapshot paging: read-only continuation of the cached serialization, no
  // page mutation. Safe in every mode including restricted.
  "page_next",
  // Download listing: reads the SW's capture ring, no page mutation, no
  // tab-level API access. Safe in every mode including restricted.
  "list_downloads",
  // Tab listing: read-only chrome.tabs.query projection, no page mutation.
  // Safe in every mode including restricted.
  "list_tabs",
  // Cookie reads: read-only chrome.cookies access — never mutates state.
  // Safe in every mode including restricted. (set_cookie / delete_cookies
  // are destructive and are gated per-mode in checkActionAllowed.)
  "get_cookies",
  // Storage reads: read-only chrome.storage access — never mutates state.
  // Safe in every mode including restricted. (set_storage / clear_storage
  // are destructive and are gated per-mode in checkActionAllowed.)
  "get_storage",
] as const;

/**
 * Check if an action type is allowed in the given mode.
 *
 * - `navigate` requires `canNavigate` (it mutates the current tab, so opening
 * a new tab must not implicitly grant current-tab navigation). New-tab opening
 * is also gated by `canNavigate` — the `navigate` action with `new_tab: true`
 * is the only path that opens a tab, so no separate tab-open capability is
 * needed (or possible) in any mode.
 * - `save_as_pdf` and `screenshot` are gated by `canDownloadFiles` (was:
 * `canDownloadFiles && mode !== "restricted"` — the mode special-case was
 * redundant since restricted mode already has `canDownloadFiles: false`).
 * - All other actions are gated by their corresponding `can*` flag.
 * - Known-but-ungated actions (click, input, scroll, etc.) are allowed in
 * every mode.
 * - Unknown action types are FAIL-CLOSED — the executor will surface a
 * "not implemented" error, but a typo or future action type added without
 * a matching case here can't silently bypass mode enforcement.
 */
export function checkActionAllowed(actionType: string, mode: AgentMode): ActionPolicyResult {
  const config = MODE_CONFIGS[mode];
  const deny = (what: string): ActionPolicyResult => ({
    allowed: false,
    reason: `${what} is not allowed in ${mode} mode`,
  });
  switch (actionType) {
    case "navigate":
 // Gate purely on `canNavigate`: `navigate` mutates the *current* tab and is
 // the only action that can open a new tab (via `new_tab: true`), so both
 // current-tab navigation and tab-opening are controlled by this single flag.
      if (!config.canNavigate) {
        return deny("Navigation");
      }
      return { allowed: true };
    case "search":
 // `search` navigates the current tab to a search-results URL — the same
 // capability boundary as `navigate`. Restricted mode (canNavigate:false)
 // must not be bypassed by emitting `search` instead of `navigate`.
      if (!config.canNavigate) {
        return deny("Search");
      }
      return { allowed: true };
    case "switch_tab":
      if (!config.canSwitchTabs) {
        return deny("Tab switching");
      }
      return { allowed: true };
    case "close_tab":
      if (!config.canCloseTabs) {
        return deny("Closing tabs");
      }
      return { allowed: true };
    case "evaluate":
      if (!config.canExecuteJs) {
        return deny("JavaScript execution");
      }
      return { allowed: true };
    case "run_script":
  // Script steps dispatch as ordinary actions (including `evaluate`), so the
  // whole script is gated by the same `canExecuteJs` flag — a script can never
  // run JS in a mode that blocks `evaluate`.
      if (!config.canExecuteJs) {
        return deny("Script execution");
      }
      return { allowed: true };
    case "upload_file":
      if (!config.canUploadFiles) {
        return deny("File upload");
      }
      return { allowed: true };
    case "save_as_pdf":
    case "screenshot":
 // Gate on the capability flag alone (no `mode === "restricted"`
 // special-case) — restricted mode already has `canDownloadFiles: false`,
 // so the redundant mode check would let a misconfigured mode silently
 // bypass the download block.
      if (!config.canDownloadFiles) {
        return deny("Downloads");
      }
      return { allowed: true };
    case "set_cookie":
    case "delete_cookies":
    case "set_storage":
    case "clear_storage":
 // Destructive cookie/storage writes mutate browser/extension state beyond
 // the current page (cookie jar, extension memory) — outside restricted
 // mode's "current tab only" confinement. There is no page capability flag
 // for these: the boundary is the mode itself. In standard mode the
 // confirmation prompt is the primary guard (see confirmRequired);
 // full_agentic allows them outright.
      if (mode === "restricted") {
        return deny("Cookie/storage mutation");
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