/**
 * chat-renderer.ts — Chat message rendering for the sidepanel.
 * Replaces log-renderer.ts for the chat-first UI.
 */

import { chatMessages } from "./elements";

const MAX_CHAT_NODES = 500;

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="13" height="13" rx="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`;

const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="20 6 9 17 4 12"/>
</svg>`;

// ─── Auto-scroll with smart tracking ─────────────────────────────────────
let userScrolledUp = false;

function initScrollBehavior(): void {
  // Create scroll-to-bottom FAB
  const scrollBtn = document.createElement("button");
  scrollBtn.type = "button";
  scrollBtn.className = "scroll-bottom-btn";
  scrollBtn.setAttribute("aria-label", "Scroll to bottom");
  scrollBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </svg>`;

  // Place FAB as sibling of chatMessages, inside the same parent
  chatMessages.parentElement?.appendChild(scrollBtn);

  chatMessages.addEventListener("scroll", () => {
    const distFromBottom =
      chatMessages.scrollHeight -
      chatMessages.scrollTop -
      chatMessages.clientHeight;
    userScrolledUp = distFromBottom > 100;
    scrollBtn.classList.toggle("visible", userScrolledUp);
  });

  scrollBtn.addEventListener("click", () => {
    userScrolledUp = false;
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "smooth" });
    scrollBtn.classList.remove("visible");
  });
}

// Initialize on module load
initScrollBehavior();

function scrollToBottom(): void {
  if (!userScrolledUp) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function capNodes(): void {
  while (chatMessages.childElementCount > MAX_CHAT_NODES) {
    chatMessages.firstChild?.remove();
  }
}

// ─── Copy button helper ──────────────────────────────────────────────────

function addCopyButton(parent: HTMLElement, text: string): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy-btn";
  btn.setAttribute("aria-label", "Copy message");
  btn.innerHTML = COPY_ICON;
  btn.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(() => {
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => {
        btn.innerHTML = COPY_ICON;
      }, 1500);
    }).catch(() => {});
  });
  parent.appendChild(btn);
}

// ─── Message rendering ───────────────────────────────────────────────────

export function addUserMessage(text: string): void {
  const el = document.createElement("div");
  el.className = "msg-user";
  el.textContent = text;
  addCopyButton(el, text);
  chatMessages.appendChild(el);
  capNodes();
  scrollToBottom();
}

export function addSystemMessage(
  icon: string,
  text: string,
  variant?: "error" | "warning",
  time?: string,
): void {
  const el = document.createElement("div");
  el.className = "msg-system" + (variant ? ` msg-${variant}` : "");
  const iconSpan = document.createElement("span");
  iconSpan.className = "msg-icon";
  iconSpan.textContent = icon;
  el.appendChild(iconSpan);
  el.appendChild(document.createTextNode(" " + text));
  if (time) {
    const timeSpan = document.createElement("span");
    timeSpan.className = "msg-time";
    timeSpan.textContent = time;
    el.appendChild(timeSpan);
  }
  addCopyButton(el, text);
  chatMessages.appendChild(el);
  capNodes();
  scrollToBottom();
}

export function removeEmptyState(): void {
  const empty = chatMessages.querySelector(".empty-state");
  if (empty) empty.remove();
}
