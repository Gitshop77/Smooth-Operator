/**
 * Human-interaction tool — lets the agent ask the user for help.
 *
 * Modes:
 * confirm — yes/no question (e.g. "Submit this form?")
 * input — ask for text input (e.g. "What's your email?")
 * password — ask for a masked secret (e.g. "Enter your API key")
 * select — ask user to pick from options (e.g. "Which shipping method?")
 * request_help — open-ended request for help (e.g. "I'm stuck, what should I do?")
 *
 * In the extension, this opens a modal in the side panel. In the demo, it
 * uses window.prompt/confirm. The agent PAUSES until the user responds.
 */

import { resolveTimeoutMs, sanitizeResponse } from "./human-interaction-utils";

/** The 5 supported interaction modes. */
export type HumanInteractionMode = "confirm" | "input" | "password" | "select" | "request_help";

/** Request payload sent by the agent to the user. */
export interface HumanInteractionRequest {
  /** Which kind of prompt to display. */
  mode: HumanInteractionMode;
  /** Question or instruction to show the user. */
  message: string;
  /** For `select` mode: the options the user can choose from. */
  options?: string[];
  /** For `input` mode: pre-filled default value. */
  defaultValue?: string;
  timeoutMs?: number;
}

/** Immutable background authority carried across the content/runtime boundary. */
export interface HumanInteractionDispatchToken {
  runId: string;
  dispatchRevision: number;
}

/** Tagged-union response from the user. */
export type HumanInteractionResponse =
  | { mode: "confirm"; confirmed: boolean }
  | { mode: "input"; value: string }
  | { mode: "password"; value: string }
  | { mode: "select"; value: string }
  | { mode: "request_help"; value: string }
  | { mode: "cancelled" }
  | { mode: "error"; reason: string };

/**
 * In the extension, send a message to the side panel and wait for its
 * `sendResponse` payload. Resolves when the side panel responds, or after the
 * timeout elapses (whichever comes first).
 */
async function askHumanExtension(
  req: HumanInteractionRequest,
  timeoutMs: number,
  signal?: AbortSignal,
  token?: HumanInteractionDispatchToken,
): Promise<HumanInteractionResponse> {
  return new Promise<HumanInteractionResponse>((resolve, reject) => {
    let settled = false;
    // Cryptographically random correlation id: a page/extension must not be
    // able to forge a HUMAN_INTERACT_CANCEL or spoof a response across the
    // runtime boundary. randomUUID is available in MV3 SW + page contexts;
    // the getRandomValues fallback covers older runtimes.
    let interactionId: string;
    try {
      interactionId = globalThis.crypto?.randomUUID?.() ??
        Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      interactionId = `human-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const cancelInBackground = () => {
      if (!token) return;
      try {
        const cancellation = chrome.runtime.sendMessage({
          type: "HUMAN_INTERACT_CANCEL",
          interactionId,
          token,
        });
        if (cancellation && typeof (cancellation as Promise<unknown>).catch === "function") {
          void (cancellation as Promise<unknown>).catch(() => {});
        }
      } catch { /* background may already be unavailable */ }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cancelInBackground();
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError"));
    };
    const finish = (resp: HumanInteractionResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(resp);
    };

    const timer = setTimeout(() => {
      cancelInBackground();
      finish({ mode: "cancelled" });
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    if (!token) {
      finish({ mode: "error", reason: "missing HUMAN_INTERACT run authority" });
      return;
    }

    try {
      void chrome.runtime.sendMessage(
        { type: "HUMAN_INTERACT_REQUEST", interactionId, token, request: req, timeoutMs },
        (response: HumanInteractionResponse | undefined) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({
              mode: "error",
              reason: lastError.message || "chrome.runtime.lastError (no receiver)",
            });
            return;
          }
          finish(sanitizeResponse(response));
        }
      );
    } catch (err) {
      finish({
        mode: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** True when running outside the Chrome extension (tests, in-page demo). */
const IS_DEMO = typeof chrome === "undefined" || !chrome.runtime?.id;

/**
 * Unified `askHuman` — dispatches to {@link askHumanExtension} when running
 * inside a Chrome extension context. Falls back to `window.confirm`/`window.prompt`
 * for test/non-extension contexts.
 */
export async function askHuman(
  req: HumanInteractionRequest,
  signal?: AbortSignal,
  token?: HumanInteractionDispatchToken,
): Promise<HumanInteractionResponse> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
  if (!IS_DEMO) {
    return askHumanExtension(req, resolveTimeoutMs(req.timeoutMs), signal, token);
  }
  if (req.mode === "confirm") {
    return { mode: "confirm", confirmed: window.confirm(req.message) };
  }
  if (req.mode === "input" || req.mode === "password") {
    const isSecret = req.mode === "password";
    if (isSecret) {
      // Only reachable when IS_DEMO is true (the extension path returned
      // above), so window.prompt is the only fallback — warn that the secret
      // is visible in plain text in the browser UI.
      console.warn("[human-interaction] password mode falling back to window.prompt — secrets visible in browser UI");
    }
    const def = isSecret ? "" : (req.defaultValue ?? "");
    const value = window.prompt(req.message, def);
    if (value === null) return { mode: "cancelled" };
    // A password must be tagged `password` (not `input`) so callers can
    // distinguish a secret from non-secret text and never copy it into
    // history/logs unredacted.
    return isSecret ? { mode: "password", value } : { mode: "input", value };
  }
  if (req.mode === "select") {
    const options = req.options ?? [];
    if (options.length === 0) {
      return { mode: "cancelled" };
    }
    const list = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    const raw = window.prompt(`${req.message}\n\n${list}`, "1");
    if (raw === null) return { mode: "cancelled" };
    const idx = Number.parseInt(raw.trim(), 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
      return { mode: "cancelled" };
    }
    return { mode: "select", value: options[idx] };
  }
  if (req.mode === "request_help") {
    const value = window.prompt(req.message);
    return value === null ? { mode: "cancelled" } : { mode: "request_help", value };
  }
  return { mode: "cancelled" };
}
