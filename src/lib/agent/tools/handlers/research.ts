/**
 * `research` action handler — delegate to the service worker, which launches
 * Lightpanda (headless Zig browser) with the main agent's AI to research the
 * query outside the user's tab. connectNative is unavailable in content
 * scripts, so this rides the TAB_ACTION channel like the other SW-side
 * actions (mirrors handlers/navigate.ts:64-98).
 */
import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { isExtensionContext, type ActionContext } from "./types";
import { rejectOnAbort } from "./abort";

/**
 * Research can legitimately run for minutes — do NOT reuse SW_RPC_TIMEOUT_MS
 * (15s). This backstop must exceed the MAX settings timeout (600s): 660s
 * (11 min). The SW/host still enforce the user's actual timeout and report
 * `done{timeout:true}`; this race only guards against a hung SW.
 */
const RESEARCH_RPC_TIMEOUT_MS = 660_000;

type ResearchRpcResponse = {
  ok?: boolean;
  success?: boolean;
  message?: string;
  error?: string;
  data?: { answer?: string; tokensIn?: number; tokensOut?: number };
};

export async function handleResearch(
  ctx: ActionContext,
  action: Extract<Action, { type: "research" }>,
): Promise<ActionResult> {
  if (!isExtensionContext()) {
    return { action, success: false, message: "research requires the installed extension (Lightpanda host)" };
  }
  try {
    let t: ReturnType<typeof setTimeout> | undefined;
    let res: ResearchRpcResponse | undefined;
    const abort = rejectOnAbort(ctx.signal);
    try {
      res = (await Promise.race([
        chrome.runtime.sendMessage({
          type: "TAB_ACTION",
          action,
          ...(ctx.dispatchToken ? { token: ctx.dispatchToken } : {}),
          ...(ctx.effectCapability ? { effectCapability: ctx.effectCapability } : {}),
        }),
        new Promise<never>((_, reject) => {
          t = setTimeout(() => reject(new Error("research TAB_ACTION timeout")), RESEARCH_RPC_TIMEOUT_MS);
        }),
        abort.promise,
      ])) as ResearchRpcResponse;
    } finally {
      if (t) clearTimeout(t);
      abort.cleanup();
    }
    if (!res?.ok) {
      return { action, success: false, message: res?.error || "research: no response" };
    }
    if (!res.success) {
      return { action, success: false, message: res.message || "research failed" };
    }
    const answer = res.data?.answer ?? "";
    const tokensIn = res.data?.tokensIn ?? 0;
    const tokensOut = res.data?.tokensOut ?? 0;
    const usageNote = tokensIn > 0 ? `\n\n[research usage: ${tokensIn} in / ${tokensOut} out]` : "";
    return {
      action,
      success: true,
      message: res.message || "research complete",
      extractedContent: `<untrusted_research>\n${answer}${usageNote}\n</untrusted_research>`,
    };
  } catch (e) {
    return { action, success: false, message: `research failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
