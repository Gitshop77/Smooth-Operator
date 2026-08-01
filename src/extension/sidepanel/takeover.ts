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
 * backgrounded).
 */

import { takeoverBanner, takeoverReason, resumeBtn } from "./elements";
import { addSystemMessage } from "./chat-renderer";

// The persistent takeover banner is an alert region for urgent events.
takeoverBanner?.setAttribute("role", "alert");
takeoverBanner?.setAttribute("aria-live", "assertive");
takeoverBanner?.setAttribute("aria-atomic", "true");

/** Last reason shown in the takeover banner, so a failed RESUME can re-offer it. */
let lastTakeoverReason: string | null = null;

/** Active dialog overlay — tracked so hideTakeoverBanner can clean up orphaned modals. */
let activeDialogOverlay: HTMLElement | null = null;

/** Active dialog finish callback — resolved when a new dialog replaces an existing one. */
let activeFinish: ((value: unknown) => void) | null = null;

// ─── Takeover banner ────────────────────────────────────────────────────────

/**
 * Show the takeover banner with the given reason.
 */
export function showTakeoverBanner(reason: string): void {
  lastTakeoverReason = reason;
  if (!takeoverBanner || !takeoverReason) return;
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
  removeActiveOverlay();
}

/** Remove any active dialog overlay, restoring focus to the trigger element. */
function removeActiveOverlay(): void {
  if (activeDialogOverlay) {
    activeDialogOverlay.remove();
    activeDialogOverlay = null;
  }
}

// The Resume button sends a RESUME message to the background.
resumeBtn?.addEventListener("click", () => {
  if (resumeBtn) resumeBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "RESUME" }, () => {
    if (chrome.runtime.lastError) {
      if (resumeBtn) resumeBtn.disabled = false;
      if (lastTakeoverReason) showTakeoverBanner(lastTakeoverReason);
      addSystemMessage(
        "❌",
        "RESUME not delivered: " + (chrome.runtime.lastError?.message || "unknown error")
      );
    } else {
      hideTakeoverBanner();
      addSystemMessage("▶", "Resuming agent…");
      // Clear the pause flag only on success — a failed RESUME should not
      // leave the session thinking the agent is unpaused.
      if (chrome.storage?.session) {
        chrome.storage.session.set({ open_cowork_paused: false }).catch(() => {});
      }
    }
  });
});

// ─── In-panel interactive modals ─────────────────────────────────────────────

/**
 * Build the shared overlay scaffolding for an interactive dialog.
 */
function buildDialogOverlay(message: string, okLabel: string) {
  // Clean up any existing dialog overlay to prevent zombie dialogs
  // when a second takeover event fires while a dialog is already open.
  if (activeFinish) { activeFinish(null as unknown); activeFinish = null; }
  removeActiveOverlay();
  const trigger = document.activeElement as HTMLElement | null;
  const uid = globalThis.crypto?.randomUUID?.() ?? `d${Math.random().toString(36).slice(2)}`;
  const labelId = `inline-prompt-label-${uid}`;

  const overlay = document.createElement("div");
  overlay.className = "password-prompt-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
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
  cancelBtn.className = "btn-ghost";

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.textContent = okLabel;
  okBtn.className = "btn-ok";

  btnRow.append(cancelBtn, okBtn);
  box.append(label, btnRow);
  overlay.append(box);
  document.body.appendChild(overlay);
  activeDialogOverlay = overlay;

  return { trigger, overlay, label, btnRow, cancelBtn, okBtn, uid };
}

/**
 * Wire the shared dismiss behavior onto an overlay.
 */
function attachDismissBehavior(
  overlay: HTMLElement,
  getFocusables: () => HTMLElement[],
  onCancel: () => void
): void {
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = getFocusables();
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
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) onCancel();
  });
}

/** A yes/no confirmation dialog. Resolves `true` for OK, `false` for Cancel / Esc / backdrop. */
export function promptConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { trigger, overlay, cancelBtn, okBtn } = buildDialogOverlay(message, "OK");

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      activeFinish = null;
      if (activeDialogOverlay === overlay) activeDialogOverlay = null;
      overlay.remove();
      trigger?.focus?.();
      resolve(value);
    };

    activeFinish = finish as (value: unknown) => void;
    okBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    attachDismissBehavior(overlay, () => [cancelBtn, okBtn], () => finish(false));
    okBtn.focus();
  });
}

/**
 * A free-text input dialog. Resolves with the typed value (OK / Enter)
 * or `null` (Cancel / Esc / backdrop).
 */
export function promptText(message: string, initialValue: string): Promise<string | null> {
  return openInputDialog({ message, masked: false, initialValue });
}

/** Masked credential input. Used by the HUMAN_INTERACT handler. */
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
    input.autocomplete = opts.masked ? "new-password" : "off";
    input.spellcheck = false;
    label.htmlFor = input.id;
    input.setAttribute("aria-label", opts.message);
    if (opts.initialValue) input.value = opts.initialValue;
    btnRow.before(input);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      activeFinish = null;
      if (activeDialogOverlay === overlay) activeDialogOverlay = null;
      overlay.remove();
      trigger?.focus?.();
      resolve(value);
    };

    activeFinish = finish as (value: unknown) => void;
    okBtn.addEventListener("click", () => finish(input.value));
    cancelBtn.addEventListener("click", () => finish(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value);
    });
    attachDismissBehavior(overlay, () => [input, cancelBtn, okBtn], () => finish(null));
    input.focus();
  });
}
