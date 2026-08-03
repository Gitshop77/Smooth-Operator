/**
 * `evaluate` action handler — run LLM-authored JS in the content-script
 * context, gated by the current page's domain allowlist/blocklist.
 * Substitutes custom-tool-call placeholders, races async results against a
 * wall-clock timeout, and reports failures with a diagnostic message.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";
import { hasPageChanged } from "./types";
import { rejectOnAbort } from "./abort";
import { checkUrlAllowed } from "../../security";
import {
  getDomainConfig,
  isDomainConfigMissingButEnforced,
} from "../helpers/domain-config";
import { runSandboxedCode } from "./evaluate-utils";
export { runSandboxedCode };

export async function handleEvaluate(
  ctx: ActionContext,
  action: Extract<Action, { type: "evaluate" }>,
): Promise<ActionResult> {
  try {
    // Gate `evaluate` by the current page's domain. Unlike `navigate` (which
    // the extension's tab-level handler intercepts), `evaluate` runs in the
    // content script, so the domain check must happen here against the current
    // page's URL. This prevents a prompt-injection payload from executing
    // arbitrary JS on an attacker-controlled domain even when a domain
    // allowlist is configured.
    //
    // `evaluate` is an unsandboxed `new Function()` RCE primitive, so the
    // domain check FAILS CLOSED when no explicit allowlist is configured
    // (`requireAllowlist: true`). Non-evaluate paths (navigate/search) keep
    // allow-all-by-default; only JS execution is hardened here.
    // `isDomainConfigMissingButEnforced()` reproduces the fail-closed behavior
    // when a domain policy was configured but its config payload is missing.
    const urlCheck =
      isDomainConfigMissingButEnforced()
        ? {
            allowed: false as const,
            reason: "Domain policy is enforced but the config is unavailable — blocking to fail closed.",
          }
        : checkUrlAllowed(location.href, getDomainConfig(), true);
    if (!urlCheck.allowed) {
      return {
        action,
        success: false,
        message: `BLOCKED evaluate on ${location.href}: ${urlCheck.reason}`,
      };
    }
    // Substitute custom tool calls: replace __opencowork_custom_tool('name')
    // placeholders with the stored custom-tool code.
    let code = action.code;
    try {
      const { substituteCustomToolCalls } = await import("../registry");
      code = await substituteCustomToolCalls(code);
    } catch (e) {
      // Substitution is a security-relevant transform: it inlines stored
      // custom-tool code in place of the LLM-authored `__opencowork_custom_tool()`
      // placeholders. If the registry can't be loaded we must NOT silently fall
      // through to executing the UNMODIFIED LLM-authored code — that would run
      // raw model output and skip the substitution the caller expected. Fail
      // closed: block the evaluate action and report why.
      console.error("[evaluate] substituteCustomToolCalls import failed:", e);
      return {
        action,
        success: false,
        message: `BLOCKED evaluate: custom-tool substitution unavailable (${
          e instanceof Error ? e.message : String(e)
        }). Refusing to run unmodified LLM-authored code.`,
      };
    }
    // Race async results against a wall-clock timeout. Synchronous infinite
    // loops can't be interrupted without a Web Worker (a larger architectural
    // change), but the timeout catches async hangs and provides a diagnostic.
    //
    // Trust model: the code below is LLM/user-authored JavaScript run in the
    // LIVE page context via `new Function`. Execution is gated only by
    // `canExecuteJs` (true solely in `full_agentic` mode) and a
    // `confirmRequired` prompt in standard mode (see the executor's mode
    // checks). The domain allow/block list constrains WHERE this code may run
    // (which origins), NOT WHAT it can do once running — code on an allowed
    // page can still make arbitrary network egress (`fetch`/WebSocket) or read
    // page data. Treat `evaluate` as a full-code-execution primitive scoped to
    // the granted origin.
    //
    // The ONE thing we must prevent is egress of the extension secret store,
    // which lives in `chrome.storage.session` (key "open_cowork_secrets", see
    // secrets.ts). The sandbox/proxy hardening in evaluate-utils.ts
    // (`runSandboxedCode`) denies `chrome`, `Function`, `eval`, `atob`/`btoa`,
    // and the window/document traversal paths (including the free identifiers
    // `parent`/`top`/`frames`/`opener`) to the real extension globals; its
    // docblock documents the threat model and the known residual bypasses
    // (obfuscated Function-constructor escapes,
    // `<anyNode>.ownerDocument.defaultView.chrome`). The `chrome.storage.session`
    // secret store is additionally unreachable from content-script scope (the
    // extension never calls `setAccessLevel`), and the remembered api-key
    // mirror (chrome.storage.local, content-script-readable by design — the
    // "remember on this device" feature) is protected only by the sandbox
    // denial above, not by platform restrictions. The proxy hardening is
    // defense-in-depth, NOT a security boundary — do not rely on this handler
    // for confidentiality.
    const syncResult = runSandboxedCode(code);
    // If the result is a Promise, race it against a timeout.
    let result: unknown = syncResult;
    if (syncResult instanceof Promise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`evaluate timed out after ${LIMITS.evaluateTimeoutMs}ms`)), LIMITS.evaluateTimeoutMs);
      });
      // Also race the step's abort signal so a user STOP is honored while async
      // evaluated code is still pending, rather than waiting out the full timeout.
      const abort = rejectOnAbort(ctx.signal);
      try {
        result = await Promise.race([syncResult, timeout, abort.promise]);
      } finally {
        if (timer) clearTimeout(timer);
        abort.cleanup();
      }
    }
    // Report `pageChanged` only when the page actually changed (live URL + DOM
    // fingerprint vs. the pre-action baseline captured in `ctx`). The old code
    // reported `pageChanged: true` unconditionally — that defeated the loop
    // detector (every `evaluate` reset the repetition window, so page-changing
    // actions could never accumulate) and forced a full DOM re-extract every
    // step. Wrapped in try/catch so a fingerprint failure can't mask a
    // successful evaluation (the evaluated code can navigate the page while
    // the fingerprint runs, detaching nodes mid-walk).
    let pageChanged = false;
    try {
      pageChanged = hasPageChanged(ctx);
    } catch {
      // Fingerprint failures are diagnostic noise, not action failures —
      // default to "no change" rather than failing the evaluation.
      pageChanged = false;
    }
    return {
      action,
      success: true,
      message: "JavaScript executed",
      // `redactSecrets` (see loop/messages.ts) only masks STORED secrets —
      // values the user explicitly registered via `setSecret`. If the
      // `evaluate` JS reads a secret that lives in the page DOM or page
      // `localStorage` of an *allowed* origin (not in our secret store), the
      // returned value below is sent to the LLM provider UNMASKED. This is a
      // known, accepted residual risk: `evaluate` is a full-code-execution
      // primitive scoped to the granted origin (see the trust-model note
      // above), and we deliberately do NOT block legit DOM/localStorage reads
      // (only `chrome` is hardened). Documented here so the limitation is
      // visible at the egress point.
      extractedContent: result !== undefined ? String(result).slice(0, LIMITS.evaluateResultChars) : undefined,
      pageChanged,
    };
  } catch (e) {
    throw new Error(
      `JS evaluation failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}
