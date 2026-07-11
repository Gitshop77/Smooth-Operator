/**
 * options/modal.ts — styled, accessible modal that replaces ALL native
 * `alert()` / `confirm()` calls across the Options page.
 *
 * Features (per REDESIGN-PLAN §6 a11y acceptance):
 *   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` / `aria-describedby`
 *   - Focus trap (Tab / Shift+Tab cycle inside the dialog)
 *   - Esc closes (resolves confirm → false, alert → void)
 *   - Focus is moved into the dialog on open and restored to the previously
 *     focused element on close
 *   - Returns a Promise so callers can `await` the user's choice
 *
 * Markup is created lazily on first use; styling lives in options.css.
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
}

let activeOverlay: HTMLDivElement | null = null;
let previouslyFocused: HTMLElement | null = null;

/** Collect focusable elements within a container, in DOM order. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  const sel = [
    "a[href]", "button:not([disabled])", "textarea:not([disabled])",
    "input:not([disabled])", "select:not([disabled])", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.offsetParent !== null,
  );
}

/**
 * Open a modal. Resolves with the `value` of the action button the user
 * clicked (or `null` if dismissed via Esc / overlay click). Only one modal may
 * be shown at a time; a second call is ignored until the first closes.
 */
export function openModal(opts: ModalOptions): Promise<string | null> {
  if (activeOverlay) return Promise.resolve(null);

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
    const close = (value: string | null) => {
      if (activeOverlay !== overlay) return;
      activeOverlay = null;
      overlay.remove();
      previouslyFocused?.focus?.();
      resolve(value);
    };

    for (const a of opts.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "btn " +
        (a.variant === "primary" ? "btn-primary" : a.variant === "danger" ? "btn-danger" : "btn-ghost");
      btn.textContent = a.label;
      btn.addEventListener("click", () => close(a.value));
      footer.appendChild(btn);
    }

    dialog.appendChild(header);
    dialog.appendChild(bodyEl);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    activeOverlay = overlay;

    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      } else if (e.key === "Tab") {
        const focusable = getFocusable(dialog);
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
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
    const target =
      autoIndex >= 0 ? (footer.children[autoIndex] as HTMLElement) : (footer.lastElementChild as HTMLElement);
    (target ?? dialog).focus();
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
    actions: [{ label: opts.okLabel ?? "OK", value: "ok", variant: "primary", autofocus: true }],
  }).then(() => undefined);
}
