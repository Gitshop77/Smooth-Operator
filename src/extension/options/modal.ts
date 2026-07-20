/**
 * options/modal.ts — styled, accessible modal that replaces ALL native
 * `alert()` / `confirm()` calls across the Options page.
 *
 * Features (per REDESIGN-PLAN §6 a11y acceptance):
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` / `aria-describedby`
 * - Focus trap (Tab / Shift+Tab cycle inside the dialog)
 * - Esc closes (resolves confirm → false, alert → void)
 * - Focus is moved into the dialog on open and restored to the previously
 * focused element on close
 * - Returns a Promise so callers can `await` the user's choice
 *
 * Markup is created lazily on first use; styling lives in options.css.
 *
 * Concurrency: only one modal is shown at a time. If `openModal` is called
 * while another modal is already open, the new request is queued and shown
 * (in order) once the active modal closes. Requests are never silently dropped
 * (previously a second caller resolved `null` and never displayed).
 */

/** A button description for the modal footer. */
export interface ModalAction {
  label: string;
  /** Value resolved by the promise when this button is clicked. */
  value: string;
  /** Visual style. */
  variant?: "primary" | "ghost" | "danger";
  /** Autofocus this button when the modal opens. */
  autofocus?: boolean;
}

export interface ModalOptions {
  title: string;
  /** Body content — an HTMLElement (preferred) or a plain-text string. */
  body: HTMLElement | string;
  actions: ModalAction[];
  /** Extra class on the dialog (e.g. "modal-wide" for the transcript viewer). */
  className?: string;
  /**
   * When set, the action button whose `value` equals `delayActionValue` starts
   * disabled and is enabled after `confirmDelayMs`. Prevents an accidental
   * Enter/space from approving a destructive state-modifying action.
   */
  delayActionValue?: string;
  confirmDelayMs?: number;
}

let activeOverlay: HTMLDivElement | null = null;
let previouslyFocused: HTMLElement | null = null;

/**
 * Pending modal-open requests, in arrival order. Each entry re-runs the open
 * once the currently active modal closes.
 */
const pendingQueue: Array<() => void> = [];

/** Collect focusable elements within a container, in DOM order. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  const sel = [
    "a[href]", "button:not([disabled])", "textarea:not([disabled])",
    "input:not([disabled])", "select:not([disabled])", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/** Open the next queued modal (if any) once the active one has closed. */
function flushQueue(): void {
  const next = pendingQueue.shift();
  if (next) next();
}

/**
 * Build, display, and resolve a single modal. Only one modal may be shown at a
 * time; the caller is responsible for queueing (see `openModal`).
 */
function showModal(opts: ModalOptions): Promise<string | null> {
  previouslyFocused = (document.activeElement as HTMLElement) ?? null;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "presentation");

  const dialog = document.createElement("div");
  dialog.className = "modal" + (opts.className ? " " + opts.className : "");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "modal-title");
  dialog.setAttribute("aria-describedby", "modal-body");
  dialog.tabIndex = -1;

  const header = document.createElement("div");
  header.className = "modal-header";
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.id = "modal-title";
  title.textContent = opts.title;
  header.appendChild(title);

  const bodyEl = document.createElement("div");
  bodyEl.className = "modal-body";
  bodyEl.id = "modal-body";
  if (typeof opts.body === "string") {
 // Treated as text to avoid accidental HTML injection; callers needing rich
 // content pass an HTMLElement (the history transcript does exactly that).
    bodyEl.textContent = opts.body;
  } else {
    bodyEl.appendChild(opts.body);
  }

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  return new Promise<string | null>((resolve) => {
    const actionButtons = new Map<string, HTMLButtonElement>();
    for (const a of opts.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "btn " +
        (a.variant === "primary" ? "btn-primary" : a.variant === "danger" ? "btn-danger" : "btn-ghost");
      btn.textContent = a.label;
      btn.addEventListener("click", () => close(a.value));
      actionButtons.set(a.value, btn);
      footer.appendChild(btn);
    }

    // Anti-misclick: keep the primary/destructive action disabled briefly so a
    // stray Enter/space can't approve it before the user reads the dialog.
    // The Cancel/close path stays instant so the user can always abort.
    if (opts.confirmDelayMs && opts.delayActionValue) {
      const target = actionButtons.get(opts.delayActionValue);
      if (target) {
        target.disabled = true;
        setTimeout(() => { target.disabled = false; }, opts.confirmDelayMs);
      }
    }

    dialog.appendChild(header);
    dialog.appendChild(bodyEl);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    // Make the background inert + lock its scroll while the modal is open, so
    // keyboard/screen-reader users can't escape into the page behind the
    // dialog (aria-modal alone doesn't prevent that) and the page can't shift.
    const inerted = Array.from(document.body.children)
      .filter((c) => c !== overlay)
      .map((c) => {
        const el = c as HTMLElement;
        const wasInert = el.inert;
        el.inert = true;
        return { el, wasInert };
      });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Defined here (AFTER `inerted` / `prevOverflow` above are initialized) so
    // it closes over those already-assigned bindings rather than relying on the
    // accident that it only runs after they're set.
    const close = (value: string | null) => {
      if (activeOverlay !== overlay) return;
      activeOverlay = null;
      inerted.forEach(({ el, wasInert }) => { el.inert = wasInert; });
      document.body.style.overflow = prevOverflow;
      overlay.remove();
      previouslyFocused?.focus?.();
      resolve(value);
      flushQueue();
    };

    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Tab") {
        // Recompute live so buttons enabled after confirmDelayMs (e.g. a danger
        // confirm) are included in the trap rather than cached while disabled.
        const current = getFocusable(dialog);
        if (current.length === 0) {
          e.preventDefault();
          return;
        }
        const first = current[0];
        const last = current[current.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });

 // Move focus into the dialog (prefer the autofocus button, else the last).
    const autoIndex = opts.actions.findIndex((a) => a.autofocus);
    let target =
      autoIndex >= 0 ? (footer.children[autoIndex] as HTMLElement) : (footer.lastElementChild as HTMLElement);
    // A disabled autofocus target (e.g. the OK button during the confirmDelayMs
    // anti-misclick window) cannot receive focus, so keyboard focus would never
    // enter the dialog and the overlay's Esc-to-close handler would not fire.
    // Fall back to the dialog node (tabIndex=-1) so focus lands inside the modal.
    if (target instanceof HTMLElement && target.hasAttribute("disabled")) {
      target = dialog;
    }
    (target ?? dialog).focus();
  });
}

/**
 * Open a modal. Resolves with the `value` of the action button the user
 * clicked (or `null` if dismissed via Esc / overlay click). Modals are shown
 * one at a time; if one is already open the new request is queued and shown
 * (in order) once the active modal closes, so no prompt is ever silently
 * dropped.
 */
export function openModal(opts: ModalOptions): Promise<string | null> {
  if (!activeOverlay) {
    return showModal(opts);
  }
  return new Promise<string | null>((resolve) => {
    pendingQueue.push(() => {
      showModal(opts).then(resolve);
    });
  });
}

export function confirmModal(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return openModal({
    title: opts.title,
    body: opts.message,
    delayActionValue: opts.danger ? "confirm" : undefined,
    confirmDelayMs: opts.danger ? 200 : undefined,
    actions: [
      { label: opts.cancelLabel ?? "Cancel", value: "cancel", variant: "ghost", autofocus: true },
      {
        label: opts.confirmLabel ?? "Confirm",
        value: "confirm",
        variant: opts.danger ? "danger" : "primary",
      },
    ],
  }).then((v) => v === "confirm");
}

export function alertModal(opts: {
  title: string;
  message: string;
  okLabel?: string;
}): Promise<void> {
  return openModal({
    title: opts.title,
    body: opts.message,
    delayActionValue: "ok",
    confirmDelayMs: 200,
    actions: [{ label: opts.okLabel ?? "OK", value: "ok", variant: "primary", autofocus: true }],
  }).then(() => undefined);
}
