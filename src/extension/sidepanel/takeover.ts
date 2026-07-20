/**
 * sidepanel/takeover.ts — takeover banner + interactive in-panel modals.
 *
 * The takeover banner appears when the agent emits a `takeover` event (the
 * agent has paused waiting for the user to perform a sensitive action —
 * login, payment, captcha, …) or a `challenge_detected` event. The user
 * performs the action manually, then clicks Resume to send a RESUME message
 * to the orchestrator.
 *
 * `promptPassword`, `promptText` and `promptConfirm` are small inline modals
 * rendered directly in the side panel (not native `window.prompt` /
 * `window.confirm`, which can silently fail to display when the panel is
 * backgrounded). `window.prompt`/`window.confirm` can also not mask input, so
 * the credential branch uses a real `<input type="password">`. All three share
 * the same overlay/behavior infrastructure below.
 */

import { takeoverBanner, takeoverReason, resumeBtn } from "./elements";
import { addLogRow } from "./log-renderer";

// The persistent takeover banner is a status region: when it is un-hidden with
// a new reason, assistive tech should announce it (e.g. the agent paused for a
// sensitive action the user must perform).
takeoverBanner?.setAttribute("role", "status");
takeoverBanner?.setAttribute("aria-live", "polite");
takeoverBanner?.setAttribute("aria-atomic", "true");

/** Last reason shown in the takeover banner, so a failed RESUME can re-offer it. */
let lastTakeoverReason: string | null = null;

// ─── Takeover banner ────────────────────────────────────────────────────────

/**
 * Show the takeover banner with the given reason. Called when the agent emits
 * a `takeover` event — the agent has paused and is waiting for the user to
 * perform a sensitive action (login, payment, captcha, …) and click Resume.
 */
export function showTakeoverBanner(reason: string): void {
  lastTakeoverReason = reason;
  if (!takeoverBanner || !takeoverReason) return;
 // `textContent` replaces the entire node's text, so a single assignment is
 // sufficient — any previously-rendered reason (including a duplicate render
 // of the same takeover event) is overwritten, never appended.
  takeoverReason.textContent = reason;
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
 // The RESUME message genuinely failed to deliver (extension context
 // invalidated, background crashed, schema mismatch). Re-show the banner with
 // a retry affordance so the user isn't left believing the agent resumed while
 // it is still paused.
      if (resumeBtn) resumeBtn.disabled = false;
      if (lastTakeoverReason) showTakeoverBanner(lastTakeoverReason);
      addLogRow(
        { type: "error", step: 0, recoverable: true, message: "RESUME not delivered: " + (chrome.runtime.lastError?.message || "unknown error") },
        ""
      );
    }
  });
 // Also clear the pause flag in case the user had clicked Pause separately
 // (the pause flag is polled by the orchestrator's runPauseCheck at the next
 // step boundary — without clearing it here, the agent would resume from the
 // takeover wait only to immediately re-pause on the next step).
  if (chrome.storage?.session) {
    chrome.storage.session.set({ open_cowork_paused: false }).catch(() => {
      /* best-effort — storage may be unavailable */
    });
  }
  hideTakeoverBanner();
  addLogRow({ type: "info", message: "Resuming agent…" }, "");
});

// ─── In-panel interactive modals ─────────────────────────────────────────────

/**
 * Build the shared overlay scaffolding for an interactive dialog: a
 * `role="dialog"` overlay with an accessible label, a message `<label>`, and an
 * OK / Cancel button row. The caller is responsible for inserting any input
 * control between the label and the button row, wiring value-producing clicks,
 * and calling `finish`.
 */
function buildDialogOverlay(message: string, okLabel = "OK") {
 // Remember which element had focus before we opened the modal so we can
 // return focus to it on close — keyboard / screen-reader users aren't
 // stranded on <body> after the dialog is removed.
  const trigger = (document.activeElement as HTMLElement | null) ?? null;

 // Scope the label/id per dialog instance so two stacked dialogs (e.g. a
 // confirm over a credential prompt) never produce duplicate element IDs or
 // ambiguous aria-labelledby/htmlFor associations.
  const uid = globalThis.crypto?.randomUUID?.() ?? `d${Math.random().toString(36).slice(2)}`;
  const labelId = `inline-prompt-label-${uid}`;

  const overlay = document.createElement("div");
  overlay.className = "password-prompt-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
 // Point the dialog's accessible name at the prompt label.
  overlay.setAttribute("aria-labelledby", labelId);

  const box = document.createElement("div");
  box.className = "password-prompt-box";

  const label = document.createElement("label");
  label.id = labelId;
  label.textContent = message;

  const btnRow = document.createElement("div");
  btnRow.className = "btn-row";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.textContent = okLabel;
  okBtn.className = "btn-ok";

  btnRow.append(cancelBtn, okBtn);
  box.append(label, btnRow);
  overlay.append(box);
  document.body.appendChild(overlay);

  return { trigger, overlay, box, label, btnRow, cancelBtn, okBtn, uid };
}

/**
 * Wire the shared dismiss behavior onto an overlay: Esc cancels (regardless of
 * which focusable control is active), a backdrop click cancels, and Tab /
 * Shift+Tab are trapped within the supplied focusable controls. `onCancel` is
 * invoked for Esc / backdrop so the caller's `finish` runs with the
 * appropriate cancel value.
 */
function attachDismissBehavior(
  overlay: HTMLElement,
  getFocusables: () => HTMLElement[],
  onCancel: () => void
): void {
 // Esc cancels regardless of which focusable control is active — the input,
 // OK, or Cancel — not only while focus sits on a particular field.
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  });
 // Backdrop click (the overlay itself, not the box) cancels.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) onCancel();
  });
 // Focus trap. Keep Tab / Shift+Tab cycling within the dialog while it's
 // open instead of escaping to the page behind it.
  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusables = getFocusables().filter((el) => !!el);
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
}

/** A yes/no confirmation dialog rendered in the side panel. Resolves `true` for OK, `false` for Cancel / Esc / backdrop. */
export function promptConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { trigger, overlay, cancelBtn, okBtn } = buildDialogOverlay(message, "OK");

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      trigger?.focus?.();
      resolve(value);
    };

    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    attachDismissBehavior(overlay, () => [cancelBtn, okBtn], () => finish(false));
 // Focus the OK button so keyboard / screen-reader users can confirm
 // immediately (they can Tab to Cancel).
    okBtn.focus();
  });
}

/**
 * A free-text input dialog rendered in the side panel. Resolves with the typed
 * value (OK / Enter) or `null` (Cancel / Esc / backdrop). `masked` swaps in a
 * `<input type="password">` for credential capture (e.g. API keys / tokens).
 */
export function promptText(message: string, initialValue = ""): Promise<string | null> {
  return openInputDialog({ message, masked: false, initialValue });
}

/** Masked credential input — see `promptText`. Used by the HUMAN_INTERACT handler when the agent requests a credential. */
export function promptPassword(message: string): Promise<string | null> {
  return openInputDialog({ message, masked: true });
}

function openInputDialog(opts: {
  message: string;
  masked: boolean;
  initialValue?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const { trigger, overlay, label, btnRow, cancelBtn, okBtn, uid } = buildDialogOverlay(
      opts.message,
      "OK"
    );

    const input = document.createElement("input");
    input.type = opts.masked ? "password" : "text";
    input.id = `inline-prompt-input-${uid}`;
 // Don't let the browser offer to save credentials typed into the masked
 // field (secret-redaction hardening) or spell-check the value.
    input.autocomplete = opts.masked ? "new-password" : "off";
    input.spellcheck = false;
 // Associate the label with the input AND give the field its own
 // accessible name so screen readers announce it even if the association
 // is lost.
    label.htmlFor = input.id;
    input.setAttribute("aria-label", opts.message);
    if (opts.initialValue) input.value = opts.initialValue;
 // Insert the input between the label and the button row.
    btnRow.before(input);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
 // Return focus to the trigger so keyboard / screen-reader users land
 // back where they were instead of on <body>.
      trigger?.focus?.();
      resolve(value);
    };

    okBtn.addEventListener("click", () => finish(input.value));
    cancelBtn.addEventListener("click", () => finish(null));
 // Enter submits from the input field (where typing happens).
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
    });
    attachDismissBehavior(overlay, () => [input, cancelBtn, okBtn], () => finish(null));
 // Auto-focus the input so the user can type immediately.
    input.focus();
  });
}
