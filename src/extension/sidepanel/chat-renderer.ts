/**
 * chat-renderer.ts — Chat message rendering for the sidepanel.
 * Replaces log-renderer.ts for the chat-first UI.
 */

import { chatMessages } from "./elements";
import { escapeHtml } from "@/extension/shared";

const MAX_CHAT_NODES = 500;

function scrollToBottom(): void {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function capNodes(): void {
  while (chatMessages.childElementCount > MAX_CHAT_NODES) {
    chatMessages.firstChild?.remove();
  }
}

export function addUserMessage(text: string): void {
  const el = document.createElement("div");
  el.className = "msg-user";
  el.textContent = text;
  chatMessages.appendChild(el);
  capNodes();
  scrollToBottom();
}

export function addSystemMessage(icon: string, text: string): void {
  const el = document.createElement("div");
  el.className = "msg-system";
  el.innerHTML = `<span class="msg-icon">${escapeHtml(icon)}</span> ${escapeHtml(text)}`;
  chatMessages.appendChild(el);
  capNodes();
  scrollToBottom();
}

export function removeEmptyState(): void {
  const empty = chatMessages.querySelector(".empty-state");
  if (empty) empty.remove();
}
