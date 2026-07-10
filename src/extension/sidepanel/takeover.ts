/**
 * sidepanel/takeover.ts — takeover banner + masked-password modal.
 *
 * The takeover banner appears when the agent emits a `takeover` event (the
 * agent has paused waiting for the user to perform a sensitive action —
 * login, payment, captcha, …) or a `challenge_detected` event. The user
 * performs the action manually, then clicks Resume to send a RESUME message
 * to the orchestrator.
 *
 * `promptPassword` is a small inline modal with a masked `<input type="password">`
 * — used by the HUMAN_INTERACT handler when the agent requests a credential.
 * `window.prompt` can't mask input, so we build a proper overlay here.
 */

import { takeoverBanner, takeoverReason, resumeBtn } from "./elements";
import { addLogRow } from "./log-renderer";

// ─── Takeover banner ────────────────────────────────────────────────────────

/**
 * Show the takeover banner with the given reason. Called when the agent emits
 * a `takeover` event — the agent has paused and is waiting for the user to
 * perform a sensitive action (login, payment, captcha, …) and click Resume.
 */
export function showTakeoverBanner(reason: string): void {
  if (!takeoverBanner || !takeoverReason) return;
  takeoverReason.textContent = `${reason} Perform the action manually, then click Resume.`;
  takeoverBanner.hidden = false;
  if (resumeBtn) {
    resumeBtn.disabled = false;
    resumeBtn.focus();
  }
}

/** Hide the takeover banner (called on resume, run-end, or new run). */
export function hideTakeoverBanner(): void {
  if (takeoverBanner) takeoverBanner.hidden = true;
}

// The Resume button sends a RESUME message to the background. The background's
// orchestrator (running in the same service-worker context) listens for this
// message via chrome.runtime.onMessage and resolves its takeover-wait promise.
resumeBtn?.addEventListener("click", () => {
  if (resumeBtn) resumeBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "RESUME" }, () => {
    if (chrome.runtime.lastError) {
      // No handler in background — the orchestrator's own onMessage listener
      // (registered when it entered the takeover wait) still catches it.
      // The lastError is expected if the background doesn't have an explicit
      // RESUME handler; non-fatal.
    }
  });
  // Also clear the pause flag in case the user had clicked Pause separately
  // (the pause flag is polled by the orchestrator's runPauseCheck at the next
  // step boundary — without clearing it here, the agent would resume from the
  // takeover wait only to immediately re-pause on the next step).
  chrome.storage.session.set({ open_cowork_paused: false }).catch(() => {
    /* best-effort — storage may be unavailable */
  });
  hideTakeoverBanner();
  addLogRow({ type: "info", message: "Resuming agent…" }, "");
});

// ─── Password prompt (masked input modal) ───────────────────────────────────

/**
 * Build a centered overlay with a `<input type="password">` + OK/Cancel
 * buttons. Resolves with the typed value (OK), or `null` (Cancel / Esc /
 * backdrop click). Removes itself from the DOM on resolve. Used by the
 * HUMAN_INTERACT handler when the agent requests a credential.
 */
export function promptPassword(message: string): Promise<string | null> {
  return new Promise((resolve) => {
    // F-39 (a11y): remember which element had focus before we opened the
    // modal so we can return focus to it on close — keyboard/screen-reader
    // users aren't stranded on <body> after the dialog is removed.
    const trigger = (document.activeElement as HTMLElement | null) ?? null;

    const overlay = document.createElement("div");
    overlay.className = "password-prompt-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    // Point the dialog's accessible name at the prompt label (F-39).
    overlay.setAttribute("aria-labelledby", "password-prompt-label");

    const box = document.createElement("div");
    box.className = "password-prompt-box";

    const label = document.createElement("label");
    label.id = "password-prompt-label";
    label.textContent = message;

    const input = document.createElement("input");
    input.type = "password";
    input.id = "password-prompt-input";
    // Associate the label with the input AND give the field its own
    // accessible name so screen readers announce it even if the association
    // is lost (F-39).
    label.htmlFor = input.id;
    input.setAttribute("aria-label", message);

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.className = "btn-ok";

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      // F-39 (a11y): return focus to the trigger so keyboard/screen-reader
      // users land back where they were instead of on <body>.
      trigger?.focus?.();
      resolve(value);
    };

    okBtn.addEventListener("click", () => finish(input.value));
    cancelBtn.addEventListener("click", () => finish(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
      if (e.key === "Escape") finish(null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    // F-39 (a11y): focus trap. Keep Tab / Shift+Tab cycling within the
    // dialog while it's open instead of escaping to the page behind it.
    overlay.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const focusables = [input, cancelBtn, okBtn].filter(
        (el): el is HTMLInputElement | HTMLButtonElement => !!el
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    // Auto-focus the input so the user can type immediately.
    setTimeout(() => input.focus(), 0);
  });
}
