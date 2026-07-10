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
import { domFingerprint, checkUrlAllowedWithDomainConfig } from "../helpers";

export async function handleEvaluate(
  ctx: ActionContext,
  action: Extract<Action, { type: "evaluate" }>,
): Promise<ActionResult> {
  try {
    // Gate `evaluate` by the current page's domain. Unlike `navigate`
    // (which is intercepted by the extension's tab-level handler),
    // `evaluate` runs in the content script — so the domain check must
    // happen here, against the current page's URL. This prevents a
    // prompt-injection payload from executing arbitrary JS on an
    // attacker-controlled domain even when a domain allowlist is configured.
    //
    // `checkUrlAllowedWithDomainConfig` (F-07) fails CLOSED when a domain
    // policy was configured but the config payload is missing, so the
    // allow/block list can't be silently bypassed via a fail-open `{}`.
    const urlCheck = checkUrlAllowedWithDomainConfig(location.href);
    if (!urlCheck.allowed) {
      return {
        action,
        success: false,
        message: `BLOCKED evaluate on ${location.href}: ${urlCheck.reason}`,
      };
    }
    // Substitute custom tool calls: if the code contains
    // __opencowork_custom_tool('name'), replace with the stored tool code.
    let code = action.code;
    try {
      const { substituteCustomToolCalls } = await import("../registry");
      code = await substituteCustomToolCalls(code);
    } catch (e) {
      // Log the import failure rather than silently falling through to
      // running unmodified LLM-authored code.
      console.warn("[executor] substituteCustomToolCalls import failed:", e);
    }
    // Wrap execution in a wall-clock timeout race. If the code returns a
    // Promise (async code), we race it against a timeout and surface a
    // timeout error if it doesn't settle. Synchronous infinite loops can't
    // be interrupted without a Web Worker (a larger architectural change) —
    // but the timeout at least catches async hangs and provides a
    // diagnostic for sync hangs (the error fires on the next event loop
    // tick after the sync loop yields, which is better than hanging forever
    // with no signal).
    // F-08 (trust-model note — NO behavior change): the code executed
    // below is LLM/user-authored JavaScript run in the LIVE page context via
    // `new Function`. It is NOT sandboxed. Execution is gated only by
    // `canExecuteJs` (true solely in `full_agentic` mode) and a
    // `confirmRequired` prompt in standard mode (see the executor's mode
    // checks). The domain allow/block list constrains WHERE this code may
    // run (which origins), NOT WHAT it can do once running — code that
    // executes on an allowed page can still make arbitrary network egress
    // (`fetch`/WebSocket) or read page data. Treat `evaluate` as a
    // full-code-execution primitive scoped to the granted origin.
    const fn = new Function(code) as () => unknown;
    const syncResult = fn();
    // If the result is a Promise, race it against a timeout.
    let result: unknown = syncResult;
    if (syncResult instanceof Promise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`evaluate timed out after ${LIMITS.evaluateTimeoutMs}ms`)), LIMITS.evaluateTimeoutMs);
      });
      try {
        result = await Promise.race([syncResult, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // F-19: only report `pageChanged` when the page actually changed.
    // The old code reported `pageChanged: true` unconditionally — that
    // defeated the loop detector (every `evaluate` reset the repetition
    // window, so page-changing actions could never accumulate) and forced
    // a full DOM re-extract every step. Compare the live URL + DOM
    // fingerprint against what the executor captured in `ctx` BEFORE this
    // handler ran. Wrapped in try/catch so a fingerprint failure can't
    // mask a successful evaluation.
    let pageChanged = false;
    try {
      pageChanged =
        location.href !== ctx.beforeUrl ||
        domFingerprint() !== ctx.beforeFingerprint;
    } catch {
      // If we can't compute the fingerprint, don't claim a page change —
      // better to skip the reset than to lie about it.
      pageChanged = false;
    }
    return {
      action,
      success: true,
      message: "JavaScript executed",
      extractedContent: result !== undefined ? String(result).slice(0, LIMITS.evaluateResultChars) : undefined,
      pageChanged,
    };
  } catch (e) {
    throw new Error(`JS evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
