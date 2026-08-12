/**
 * Action executor — takes a validated {@link AgentAction} and performs it on
 * the page. Returns an {@link ActionResult} that's surfaced in the agent
 * history and shown to the user.
 *
 * Tab-level actions (`navigate`, `switch_tab`, `close_tab`, `search`) need
 * `chrome.tabs` API access, which is only available in the extension's
 * background/service worker — not in the content-script context where this
 * dispatcher runs. The *handlers* for those actions (`./handlers/navigate.ts`,
 * `./handlers/tab-management.ts`) delegate by sending
 * `chrome.runtime.sendMessage({ type: "TAB_ACTION", action })` to the service
 * worker, which performs the real `chrome.tabs` work.
 *
 * Separately, the agent loop's action-queue layer
 * (`../loop/helpers/action-queue.ts`) *optionally* wraps `executeAction` and
 * offers an `onTabAction` hook that can intercept tab-level actions before they
 * reach the handlers. Note that `executeAction` itself receives **no hook** —
 * any tab delegation is done inside the handlers via message passing, or by the
 * action-queue layer above it.
 *
 * This module is now a thin dispatcher: the per-action logic lives in
 * `./handlers/*`, the shared helpers live in `./helpers/*`, the constants
 * live in `./constants.ts`, and the description string lives in
 * `./describe.ts`. The dispatcher:
 * 1. Captures `beforeUrl` + `beforeFingerprint` (used by click /
 * go_back / press_and_hold for page-change detection).
 * 2. Switches on `action.type` and delegates to the matching handler.
 * 3. Wraps handler dispatch in a try/catch that converts *runtime* handler
 * errors into `{ success: false, message: "..." }` results. The
 * exhaustiveness guard is a programming error and is re-thrown (see
 * {@link UnhandledActionError}) rather than downgraded to a soft failure.
 *
 * Honesty note on the "fail-loud" guarantee: the re-throw is only observed
 * by DIRECT callers of `executeAction`. The primary production caller (the
 * agent loop's `runLocalAction` → `toActionError`) wraps `executeAction` in
 * its own catch-all, which flattens the re-thrown error into a routine
 * failed `ActionResult` whose message starts `Error: unhandled action type:
 * …`. The defect still surfaces in the message (and the error type name is
 * preserved), but it is NOT a hard stop at the queue level — do not rely on
 * `UnhandledActionError` halting the agent loop.
 *
 * Public API (kept stable for backward compatibility):
 * - {@link executeAction} — the main entry point
 * - {@link describeAction} — re-exported from `./describe`
 */

import type { ActionResult, AgentAction, BrowserState } from "../types";

import { describeAction } from "./describe";
import { ActionSchema } from "./schema";
import { parseScriptYaml, validateScript, runScript, type ScriptDispatchFn } from "../script-runner";
import { makeLazyFingerprint } from "./handlers/types";
import { detectChallenges } from "../dom/challenge-snapshot";
import { tryExpandSearchMacro, SW_RPC_TIMEOUT_MS } from "./constants";
import { classifyActionError, formatErrorSuffix } from "../errors";
import type { AgentMode } from "../modes";
import { currentCapabilityPolicy } from "../capability-policy";
import { pageSnapshotChunk } from "../dom/extraction/page-state";
import { readLoaderRegistry, runMatchedLoaders } from "../dom/navigation/url-loaders";
import { isExtensionContext, type LoaderRunner } from "./handlers/types";
import { rejectOnAbort, throwIfAborted } from "./handlers/abort";
import {
  handleAlertAccept,
  handleAlertDismiss,
  handleAlertGetText,
  handleAlertSendKeys,
  handleAskHuman,
  handleClearStorage,
  handleCloseTab,
  handleClick,
  handleDeleteCookies,
  handleDetectVisual,
  handleDone,
  handleDropdownOptions,
  handleEvaluate,
  handleExtract,
  handleFindElements,
  handleListInteractive,
  handleFindText,
  handleGetCookies,
  handleGetStorage,
  handleGoBack,
  handleHover,
  handleInput,
  handleListTabs,
  handleLoadSkill,
  handleNavigate,
  handlePressAndHold,
  handleSaveAsPdf,
  handleScreenshot,
  handleScroll,
  handleScrollToBottom,
  handleSearch,
  handleSearchPage,
  handleSelectDropdown,
  handleSendKeys,
  handleSetCookie,
  handleSetStorage,
  handleSwitchTab,
  handleTakeover,
  handleUploadFile,
  handleVerify,
  handleWait,
  handleWaitForElement,
  handleWaitForNetworkIdle,
  handleWaitForText,
  handleWaitForUrl,
  handleEnableNetworkLog,
  handleDisableNetworkLog,
  handleGetNetworkLog,
  handleClearNetworkLog,
  handleGetclearNetworkLog,
  handleEnableConsoleLog,
  handleDisableConsoleLog,
  handleGetConsoleLog,
  handleClearConsoleLog,
  handleGetclearConsoleLog,
  handleGetComputedStyle,
  handleGetPageInfo,
  type ActionContext,
  type ActionDispatchToken,
} from "./handlers";

export { describeAction };

/** Response shape of the SW's TAB_ACTION handler (incl. list_downloads). */
type TabActionRpcResponse = {
  ok?: boolean;
  success?: boolean;
  message?: string;
  pageChanged?: boolean;
  error?: string;
  downloads?: Array<{ filename: string; mime?: string; sizeBytes?: number }>;
};

/**
 * Thrown by the switch `default` branch when an {@link AgentAction} variant
 * reaches `executeAction` without a matching handler. This indicates a
 * programming error (a new action type added to the union but not cased here),
 * not a recoverable runtime failure of an otherwise-valid action. `executeAction`
 * therefore re-throws it instead of downgrading it to a soft `{ success: false }`
 * result, so direct callers see the defect loudly rather than silently
 * swallowed. Caveat: the agent loop's `runLocalAction` catch-all flattens the
 * re-throw into a routine failed `ActionResult` — the message still names the
 * unhandled type, but the guarantee does not extend to a queue-level hard stop.
 */
class UnhandledActionError extends Error {
  /** Stable machine code for the error vocabulary (P2/E7). */
  readonly machineCode = "action_unsupported";
  /** Programming errors are never retried. */
  readonly retryable = false;
  readonly recoveryHint = "This action type is not supported. Choose an action from the supported list.";
  constructor(action: { type: string }) {
    super(`unhandled action type: ${action.type}`);
    this.name = "UnhandledActionError";
  }
}

/**
 * Build the S6 URL-loader runner for a fresh agent-driven navigation. Loader
 * steps are dispatched as ordinary actions with `fromLoader: true` so a
 * loader-originated `navigate` never re-triggers loaders (recursion guard).
 *
 * When an `agentMode` is provided (the agent loop threads the active mode
 * in), each loader step is checked with `checkActionAllowed` BEFORE dispatch
 * — the same gate the action-queue applies to loop actions. Loader steps are
 * user-authored registry content, so they must not be able to cross the
 * mode's capability boundary (e.g. an `evaluate` / `run_script` step running
 * JS in standard mode) just because the loop gate lives one layer above the
 * executor. With no mode, steps dispatch ungated exactly as before.
 */
function makeLoaderRunner(
  state: BrowserState,
  signal?: AbortSignal,
  agentMode?: AgentMode,
  dispatchToken?: ActionDispatchToken,
  effectAuthorizer?: (action: AgentAction) => Promise<string>,
): LoaderRunner {
  return async (url: string) =>
    runMatchedLoaders({
      url,
      readRegistry: readLoaderRegistry,
      dispatch: async (step) => {
        if (agentMode) {
          const capability = currentCapabilityPolicy.decide({
            actionType: step.type,
            mode: agentMode,
            enforcementPoint: "loader-step",
          });
          if (!capability.allowed) {
            return { action: step, success: false, message: `BLOCKED: ${capability.reason}` };
          }
        }
        return executeAction(step, state, signal, true, agentMode, dispatchToken, undefined, effectAuthorizer);
      },
    });
}

/**
 * Settings source for `${env.VAR}` substitution inside scripts. The wiring
 * layer points this at a synchronous settings lookup when one is available;
 * content-script contexts have no settings snapshot (chrome.storage is
 * async-only there), so the default resolves missing keys to "" — the
 * engine's documented missing-key behavior.
 */
let scriptEnvGetter: ((key: string) => string) | undefined;

export function setScriptEnvGetter(getter: ((key: string) => string) | undefined): void {
  scriptEnvGetter = getter;
}

function resolveScriptEnv(key: string): string {
  return scriptEnvGetter ? scriptEnvGetter(key) : "";
}

/**
 * Convert a script step (engine shape: `action` + params, `output_id` handled
 * by the engine itself) into a validated {@link AgentAction} for the executor.
 * `eval` steps (used by element/text/url conditions) route to the same
 * fail-closed `evaluate` handler as the agent loop. Returns null when the step
 * cannot be parsed — the caller reports it as an honest per-step failure.
 */
function scriptStepToAction(step: Record<string, unknown>): AgentAction | null {
  if (step.action === "eval" && typeof step.expression === "string") {
    const parsed = ActionSchema.safeParse({ type: "evaluate", code: step.expression });
    return parsed.success ? parsed.data : null;
  }
  if (typeof step.action !== "string" || step.action === "") return null;
  if (step.action === "run_script") return null; // nested scripts would recurse unbounded through the executor
  const candidate: Record<string, unknown> = { type: step.action };
  for (const [key, value] of Object.entries(step)) {
    if (key !== "action" && key !== "output_id") candidate[key] = value;
  }
  const parsed = ActionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Execute a single content-script-level action.
 *
 * Tab-level actions (`navigate`, `switch_tab`, `close_tab`, `search`) are
 * dispatched to their handlers like any other action; those handlers
 * themselves delegate to the service worker via
 * `chrome.runtime.sendMessage({ type: "TAB_ACTION", action })`. This function
 * receives no `onTabAction` hook — any such interception happens in the
 * action-queue layer above it.
 *
 * @param action The validated action to execute.
 * @param state The current browser state (used to resolve `[index]` → element).
 * @param signal Optional abort signal threaded from the agent loop.
 * @param fromLoader True when the action originates from a URL-loader step —
 *   suppresses the loader hook so loaders never re-trigger on their own
 *   navigation (S6 recursion guard).
 * @param agentMode Optional active agent mode. When provided, URL-loader
 *   steps spawned by a `navigate`/`search` are mode-gated with
 *   `checkActionAllowed` before dispatch (see {@link makeLoaderRunner}); the
 *   loop threads this so user-authored loaders cannot bypass the mode
 *   capability boundary. Undefined (direct content-script callers) keeps
 *   loader steps ungated.
 * @returns An {@link ActionResult} describing what happened.
 */
export async function executeAction(
  action: AgentAction,
  state: BrowserState,
  signal?: AbortSignal,
  fromLoader?: boolean,
  agentMode?: AgentMode,
  dispatchToken?: ActionDispatchToken,
  effectCapability?: string,
  effectAuthorizer?: (action: AgentAction) => Promise<string>,
): Promise<ActionResult> {
  try {
    // This is the universal action boundary. Loader and script recursion can
    // enter the executor without passing through the loop queue, so every
    // action must independently reject a pre-aborted run before even reading
    // page state (domFingerprint) or invoking a synchronous handler.
    throwIfAborted(signal);
    const actionEffectCapability = effectAuthorizer
      ? await effectAuthorizer(action)
      : effectCapability;
  // Capture before-state once at the top — used by the click, go_back,
  // select_dropdown, press_and_hold, and evaluate handlers for page-change
  // detection. The fingerprint is LAZY (memoized on first read) so actions
  // that never check for page changes don't pay the O(interactive-elements)
  // DOM scan. Handlers that DO check must see the PRE-effect fingerprint, so
  // resolve it here (before dispatch) for exactly those action types — a
  // lazy resolution inside the handler would capture the POST-effect DOM and
  // report "no change" for a mutation the action actually caused.
    const ctx: ActionContext = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: makeLazyFingerprint() as unknown as string,
      signal,
      dispatchToken,
      effectCapability: actionEffectCapability,
      fromLoader: fromLoader ?? false,
    };
    if (
      action.type === "click" ||
      action.type === "go_back" ||
      action.type === "select_dropdown" ||
      action.type === "press_and_hold" ||
      action.type === "evaluate"
    ) {
      (ctx.beforeFingerprint as unknown as { get(): string }).get();
    }

    switch (action.type) {
      case "click":           return await handleClick(ctx, action);
      case "input":           return await handleInput(ctx, action);
      case "select_dropdown": return await handleSelectDropdown(ctx, action);
      case "scroll":          return await handleScroll(ctx, action);
      case "scroll_to_bottom": return await handleScrollToBottom(ctx, action);
      case "send_keys":       return await handleSendKeys(ctx, action);
      case "navigate": {
        const macroUrl = tryExpandSearchMacro(action.url)?.url;
        const navAction = macroUrl ? { ...action, url: macroUrl } : action;
        return await handleNavigate(ctx, navAction, makeLoaderRunner(state, signal, agentMode, dispatchToken, effectAuthorizer));
      }
      case "switch_tab":      return await handleSwitchTab(ctx, action);
      case "close_tab":       return await handleCloseTab(ctx, action);
      case "list_tabs":       return await handleListTabs(ctx, action);
      case "get_cookies":     return await handleGetCookies(ctx, action);
      case "set_cookie":      return await handleSetCookie(ctx, action);
      case "delete_cookies":  return await handleDeleteCookies(ctx, action);
      case "get_storage":     return await handleGetStorage(ctx, action);
      case "set_storage":     return await handleSetStorage(ctx, action);
      case "clear_storage":   return await handleClearStorage(ctx, action);
      case "go_back":         return await handleGoBack(ctx, action);
      case "wait":            return await handleWait(ctx, action);
      case "wait_for_element":    return await handleWaitForElement(ctx, action);
      case "wait_for_text":       return await handleWaitForText(ctx, action);
      case "wait_for_url":        return await handleWaitForUrl(ctx, action);
      case "wait_for_network_idle": return await handleWaitForNetworkIdle(ctx, action);
      case "enable_network_log":  return await handleEnableNetworkLog(ctx, action);
      case "disable_network_log": return await handleDisableNetworkLog(ctx, action);
      case "get_network_log":     return await handleGetNetworkLog(ctx, action);
      case "clear_network_log":   return await handleClearNetworkLog(ctx, action);
      case "getclear_network_log": return await handleGetclearNetworkLog(ctx, action);
      case "enable_console_log":  return await handleEnableConsoleLog(ctx, action);
      case "disable_console_log": return await handleDisableConsoleLog(ctx, action);
      case "get_console_log":     return await handleGetConsoleLog(ctx, action);
      case "clear_console_log":   return await handleClearConsoleLog(ctx, action);
      case "getclear_console_log": return await handleGetclearConsoleLog(ctx, action);
      case "find_text":       return await handleFindText(ctx, action);
      case "extract":         return await handleExtract(ctx, action);
      case "search": {
        const macroUrl = tryExpandSearchMacro(action.query)?.url;
        if (macroUrl) {
          return await handleNavigate(ctx, { type: "navigate", url: macroUrl, new_tab: false }, makeLoaderRunner(state, signal, agentMode, dispatchToken, effectAuthorizer));
        }
        return await handleSearch(ctx, action);
      }
      case "upload_file":     return await handleUploadFile(ctx, action);
      case "screenshot":      return await handleScreenshot(ctx, action);
      case "save_as_pdf":     return await handleSaveAsPdf(ctx, action);
      case "dropdown_options":return await handleDropdownOptions(ctx, action);
      case "search_page":     return await handleSearchPage(ctx, action);
      case "find_elements":   return await handleFindElements(ctx, action);
      case "list_interactive": return await handleListInteractive(ctx, action);
      case "get_computed_style": return handleGetComputedStyle(ctx, action);
      case "get_page_info":   return handleGetPageInfo(ctx, action);
      case "evaluate":        return await handleEvaluate(ctx, action);
      case "run_script": {
        // Parse + validate FIRST so an invalid script is an honest, reported
        // failure instead of a throw at the top of runScript's re-validation.
        let scriptData: unknown;
        try {
          scriptData = parseScriptYaml(action.script);
          validateScript(scriptData);
        } catch (e) {
          return {
            action,
            success: false,
            message: `run_script: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        // Each script step dispatches as an ordinary action. Step records use
        // an `action` field (not `type`) and carry script-only keys; the
        // adapter maps them to a validated AgentAction. Script steps run with
        // fromLoader:false — only loader-originated steps set that flag.
        const dispatch: ScriptDispatchFn = async (step) => {
          const parsed = scriptStepToAction(step);
          if (!parsed) {
            return {
              success: false,
              message: `unrecognized script step: ${String((step as { action?: unknown }).action ?? "")}`,
            };
          }
          const result = await executeAction(parsed, state, signal, false, agentMode, dispatchToken, undefined, effectAuthorizer);
          return {
            success: result.success,
            data: result.data,
            extractedContent: result.extractedContent,
            // Ride the handler message through so the envelope's step_results
            // explain WHY a step failed (not just that it did).
            message: result.message,
          };
        };
        const envelope = await runScript(scriptData, dispatch, { getEnv: resolveScriptEnv });
        return {
          action,
          success: envelope.success,
          message: `run_script "${envelope.name}": ${envelope.steps_executed}/${envelope.steps_total} steps in ${envelope.duration}s`,
          extractedContent: JSON.stringify(envelope),
          pageChanged: true,
        };
      }
      case "hover":           return await handleHover(ctx, action);
      case "press_and_hold":  return await handlePressAndHold(ctx, action);
      case "ask_human":       return await handleAskHuman(ctx, action);
      case "takeover":        return await handleTakeover(ctx, action);
      case "verify":          return await handleVerify(ctx, action);
      case "load_skill":      return await handleLoadSkill(ctx, action);
      case "alert_accept":    return await handleAlertAccept(ctx, action);
      case "alert_dismiss":   return await handleAlertDismiss(ctx, action);
      case "alert_get_text":  return await handleAlertGetText(ctx, action);
      case "alert_send_keys": return await handleAlertSendKeys(ctx, action);
      case "detect_visual":  return await handleDetectVisual(ctx, action);
      case "detect_challenge": {
        // Read-only classifier running in the content script — the result is
        // sanitised (no page-controlled text, bounded matches) so it can ride
        // the extractedContent channel like other machine-readable reads.
        const result = detectChallenges({ scrollIntoView: action.scroll_into_view === true });
        const vendors = result.matches.map((m) => `${m.vendor}(${m.confidence})`).join(", ");
        return {
          action,
          success: true,
          message: result.detected
            ? `detect_challenge: ${result.matches.length} challenge(s) — ${vendors}`
            : `detect_challenge: no challenges detected (${result.status})`,
          extractedContent: JSON.stringify(result),
        };
      }
      case "list_downloads": {
        // Downloads live in the service worker (chrome.downloads is not
        // available in the content-script world), so this reads the SW's
        // capture ring over the TAB_ACTION channel — raced against a timeout
        // and the step's abort signal (see navigate.ts for the same pattern).
        if (!isExtensionContext()) {
          return { action, success: false, message: "list_downloads requires the extension context" };
        }
        try {
          let t: ReturnType<typeof setTimeout> | undefined;
          let res: TabActionRpcResponse | undefined;
          const abort = rejectOnAbort(ctx.signal);
          try {
            res = (await Promise.race([
              chrome.runtime.sendMessage({ type: "TAB_ACTION", action, ...(ctx.dispatchToken ? { token: ctx.dispatchToken } : {}), ...(ctx.effectCapability ? { effectCapability: ctx.effectCapability } : {}) }),
              new Promise<never>((_, reject) => {
                t = setTimeout(() => reject(new Error("TAB_ACTION timeout")), SW_RPC_TIMEOUT_MS);
              }),
              abort.promise,
            ])) as TabActionRpcResponse;
          } finally {
            if (t) clearTimeout(t);
            abort.cleanup();
          }
          if (!res?.ok) {
            return { action, success: false, message: `list_downloads failed: ${res?.error || "no response"}` };
          }
          const downloads = res.downloads ?? [];
          const listing = downloads.length > 0
            ? downloads.map((d) => `${d.filename} (${d.sizeBytes} bytes, ${d.mime})`).join("\n")
            : "no downloads captured in this session";
          return {
            action,
            success: !!res.success,
            message: res.message || `list_downloads: ${downloads.length} captured`,
            extractedContent: `<untrusted_downloads>\n${listing}\n</untrusted_downloads>`,
          };
        } catch (e) {
          return { action, success: false, message: `list_downloads failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      case "page_next": {
        // Window a cached snapshot serialization; the LLM resumes with the
        // next offset via the marker embedded in the extracted content.
        const windowed = pageSnapshotChunk(action.offset);
        if (!windowed) {
          return {
            action,
            success: false,
            message: "page_next failed: no page snapshot cached — extract the page state first",
          };
        }
        const windowText = windowed.text.trim();
        return {
          action,
          success: true,
          message: windowed.hasMore
            ? `page_next: window at char ${windowed.offset} of ${windowed.totalChars} — call page_next with offset=${windowed.nextOffset} for more`
            : `page_next: final window of ${windowed.totalChars} chars`,
          extractedContent: windowText.length > 0
            ? `<untrusted_page_state>\n${windowText}\n</untrusted_page_state>`
            : "[empty page]",
        };
      }
      case "done":            return await handleDone(ctx, action);

      default: {
 // Exhaustiveness check: if a new action type is added to the union
 // without a case here, TypeScript will fail to compile. At runtime this
 // is a programming error, so we throw a dedicated error that the catch
 // below re-throws (it must not be downgraded to a soft failure).
        const _exhaustive: never = action;
        throw new UnhandledActionError(_exhaustive);
      }
    }
  } catch (e) {
 // A programming error (the exhaustiveness guard) must surface as a hard
 // throw, not as a routine failed action — for DIRECT callers. The agent
 // loop's catch-all (`runLocalAction` → `toActionError`) flattens this into
 // a routine failure whose message still names the unhandled type.
    if (e instanceof UnhandledActionError) throw e;

 // Runtime handler errors are recoverable: report them as a failed result.
 // Preserve the error's constructor name so the type (e.g. "TypeError")
 // isn't flattened away, aiding debugging without leaking the full stack to
 // the user-facing message. The classification suffix gives the loop/LLM a
 // stable code + retry guidance (see classifyActionError in errors-utils).
    const err = e instanceof Error ? e : new Error(String(e));
    const classified = classifyActionError(err);
    return {
      action,
      success: false,
      message: `${action.type} failed: ${err.name}: ${err.message} ${formatErrorSuffix(
        classified.machineCode,
        classified.retryable,
        classified.recoveryHint,
      )}`,
    };
  }
}
