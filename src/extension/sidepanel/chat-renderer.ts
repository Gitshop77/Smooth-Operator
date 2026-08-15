/**
 * chat-renderer.ts — Chat message rendering for the sidepanel.
 * Replaces log-renderer.ts for the chat-first UI.
 */

import { chatMessages } from "./elements";
import { redactKeyLeak } from "@/extension/shared";
import { prefersReducedMotion } from "../accessibility";
import type { LogEvent, LLMPromptStats } from "@/lib/agent/types";
import { renderSafeMarkdown } from "./safe-markdown";

// Rich activity cards have substantially more descendants than the old
// one-line rows. Keep ~100-step runs comfortably visible while preventing a
// multi-hour run from retaining thousands of expanded reasoning subtrees.
const MAX_CHAT_NODES = 800;
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact", maximumFractionDigits: 1,
});
const liveCallCards = new Map<string, {
  card: HTMLElement; status: HTMLElement; timer: ReturnType<typeof setInterval>;
  outputChars: number; chunkCount: number;
}>();
const pendingActionCards = new Map<string, HTMLElement[]>();
const pendingJudgeCards = new Map<number, HTMLElement>();
const renderedAssistantMessages = new Set<string>();

/**
 * Microtask-coalesced DOM batching: bursty thinking/action/state events create
 * one node each; appending through one DocumentFragment per tick collapses N
 * appends + N scrollHeight layout reads into 1, without changing the
 * synchronous-ish render contract the transcript tests rely on.
 */
const pendingNodes: HTMLElement[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    if (pendingNodes.length === 0) return;
    const fragment = document.createDocumentFragment();
    for (const node of pendingNodes) fragment.appendChild(node);
    pendingNodes.length = 0;
    chatMessages.appendChild(fragment);
    capNodes();
    scrollToBottom();
  });
}

function enqueueNode(node: HTMLElement): void {
  pendingNodes.push(node);
  scheduleFlush();
}

function safeText(value: string): string {
  return redactKeyLeak(value);
}

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value);
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Per-action presentation: emoji icon, friendly label, and accent color so the
 * live activity timeline reads at a glance ("Click", "Type", "Navigate", …).
 * Unknown/new action types fall back to a neutral bolt + capitalized name.
 */
const ACTION_META: Record<string, { icon: string; label: string; accent: string }> = {
  click: { icon: "🖱️", label: "Click", accent: "#f59e0b" },
  hover: { icon: "✋", label: "Hover", accent: "#f59e0b" },
  press_and_hold: { icon: "👆", label: "Press & hold", accent: "#f59e0b" },
  input: { icon: "⌨️", label: "Type", accent: "#38bdf8" },
  send_keys: { icon: "🔑", label: "Press keys", accent: "#38bdf8" },
  select_dropdown: { icon: "📑", label: "Select option", accent: "#a78bfa" },
  dropdown_options: { icon: "📋", label: "List options", accent: "#a78bfa" },
  scroll: { icon: "🖱️", label: "Scroll", accent: "#94a3b8" },
  scroll_to_bottom: { icon: "⏬", label: "Scroll to bottom", accent: "#94a3b8" },
  navigate: { icon: "🧭", label: "Navigate", accent: "#60a5fa" },
  switch_tab: { icon: "🔄", label: "Switch tab", accent: "#60a5fa" },
  close_tab: { icon: "✖️", label: "Close tab", accent: "#f87171" },
  go_back: { icon: "↩️", label: "Go back", accent: "#60a5fa" },
  wait: { icon: "⏳", label: "Wait", accent: "#a3a3a3" },
  wait_for_element: { icon: "⏳", label: "Wait for element", accent: "#a3a3a3" },
  wait_for_text: { icon: "⏳", label: "Wait for text", accent: "#a3a3a3" },
  wait_for_url: { icon: "⏳", label: "Wait for URL", accent: "#a3a3a3" },
  wait_for_network_idle: { icon: "🌐", label: "Wait for network idle", accent: "#a3a3a3" },
  extract: { icon: "📤", label: "Extract data", accent: "#34d399" },
  find_text: { icon: "🔍", label: "Find text", accent: "#22d3ee" },
  search: { icon: "🔎", label: "Search web", accent: "#22d3ee" },
  search_page: { icon: "🔍", label: "Search page", accent: "#22d3ee" },
  find_elements: { icon: "🧩", label: "Find elements", accent: "#34d399" },
  list_interactive: { icon: "🧾", label: "List interactive elements", accent: "#34d399" },
  list_tabs: { icon: "🗂️", label: "List tabs", accent: "#60a5fa" },
  evaluate: { icon: "⚙️", label: "Run JavaScript", accent: "#c084fc" },
  run_script: { icon: "⚙️", label: "Run script", accent: "#c084fc" },
  screenshot: { icon: "📸", label: "Take screenshot", accent: "#c084fc" },
  save_as_pdf: { icon: "📄", label: "Save as PDF", accent: "#c084fc" },
  inspect_visual: { icon: "👁️", label: "Inspect visually", accent: "#c084fc" },
  detect_visual: { icon: "🔭", label: "Detect visually", accent: "#c084fc" },
  detect_challenge: { icon: "🛡️", label: "Detect challenge", accent: "#fbbf24" },
  upload_file: { icon: "📤", label: "Upload file", accent: "#f472b6" },
  done: { icon: "✅", label: "Finish", accent: "#4ade80" },
  verify: { icon: "🧪", label: "Verify", accent: "#2dd4bf" },
  ask_human: { icon: "🙋", label: "Ask you", accent: "#fbbf24" },
  takeover: { icon: "🤝", label: "Takeover", accent: "#fbbf24" },
  alert_accept: { icon: "🟢", label: "Accept alert", accent: "#4ade80" },
  alert_dismiss: { icon: "⚪", label: "Dismiss alert", accent: "#94a3b8" },
  alert_get_text: { icon: "💬", label: "Read alert", accent: "#94a3b8" },
  alert_send_keys: { icon: "⌨️", label: "Type into alert", accent: "#38bdf8" },
  get_cookies: { icon: "🍪", label: "Read cookies", accent: "#fbbf24" },
  set_cookie: { icon: "🍪", label: "Set cookie", accent: "#fbbf24" },
  delete_cookies: { icon: "🍪", label: "Delete cookies", accent: "#f87171" },
  get_storage: { icon: "🗄️", label: "Read storage", accent: "#94a3b8" },
  set_storage: { icon: "🗄️", label: "Write storage", accent: "#94a3b8" },
  clear_storage: { icon: "🗄️", label: "Clear storage", accent: "#f87171" },
  get_page_info: { icon: "ℹ️", label: "Page info", accent: "#94a3b8" },
  page_next: { icon: "⏭️", label: "Next page", accent: "#60a5fa" },
  list_downloads: { icon: "📥", label: "List downloads", accent: "#60a5fa" },
};

function actionMeta(name: string): { icon: string; label: string; accent: string } {
  const known = ACTION_META[name];
  if (known) return known;
  return {
    icon: "⚡",
    label: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    accent: "#f59e0b",
  };
}

function activityCard(icon: string, title: string, status: string, time?: string): {
  card: HTMLElement; status: HTMLElement; body: HTMLElement;
} {
  const card = document.createElement("article");
  card.className = "activity-card";

  const header = document.createElement("header");
  header.className = "activity-header";
  const iconEl = document.createElement("span");
  iconEl.className = "activity-icon";
  iconEl.textContent = icon;
  const titleEl = document.createElement("strong");
  titleEl.className = "activity-title";
  titleEl.textContent = safeText(title);
  const statusEl = document.createElement("span");
  statusEl.className = "activity-status";
  statusEl.textContent = safeText(status);
  header.append(iconEl, titleEl, statusEl);
  if (time) {
    const timeEl = document.createElement("time");
    timeEl.className = "activity-time";
    timeEl.textContent = time;
    header.appendChild(timeEl);
  }
  const body = document.createElement("div");
  body.className = "activity-body";
  card.append(header, body);
  return { card, status: statusEl, body };
}

function addActivityField(parent: HTMLElement, label: string, value: string, open = true): void {
  if (!value) return;
  const details = document.createElement("details");
  details.className = "activity-detail";
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = label;
  const content = document.createElement("div");
  content.className = "activity-detail-content";
  content.textContent = safeText(value);
  details.append(summary, content);
  parent.appendChild(details);
}

function promptSummary(prompt: LLMPromptStats): string {
  const parts = [
    `~${formatCompactNumber(prompt.requestChars)} request-data chars`,
    `${prompt.historyItems} history`,
  ];
  if (prompt.elementsChars) parts.push(`${formatCompactNumber(prompt.elementsChars)} DOM`);
  if (prompt.axTreeChars) parts.push(`${formatCompactNumber(prompt.axTreeChars)} AX`);
  if (prompt.screenshotChars) parts.push(`${formatCompactNumber(prompt.screenshotChars)} image`);
  if (prompt.compactedMemoryChars) parts.push(`${formatCompactNumber(prompt.compactedMemoryChars)} memory`);
  if (prompt.planItems) parts.push(`${prompt.planItems} plan items`);
  parts.push("system prompt reflected in final input tokens");
  return parts.join(" · ");
}

function usageSummary(event: Extract<LogEvent, { type: "llm-call-end" }>): string {
  const parts: string[] = [];
  if (event.tokensIn !== undefined) parts.push(`${formatCompactNumber(event.tokensIn)} in`);
  if (event.tokensOut !== undefined) parts.push(`${formatCompactNumber(event.tokensOut)} out`);
  if (event.reasoningTokens) parts.push(`${formatCompactNumber(event.reasoningTokens)} reasoning`);
  if (event.cachedInputTokens) parts.push(`${formatCompactNumber(event.cachedInputTokens)} cache read`);
  if (event.cachedWriteInputTokens) parts.push(`${formatCompactNumber(event.cachedWriteInputTokens)} cache write`);
  if (event.outputChars) parts.push(`${formatCompactNumber(event.outputChars)} output chars`);
  return parts.join(" · ");
}

export function resetActivityRenderState(): void {
  for (const value of liveCallCards.values()) clearInterval(value.timer);
  liveCallCards.clear();
  pendingActionCards.clear();
  pendingJudgeCards.clear();
  renderedAssistantMessages.clear();
}

export function addLLMCallStart(event: Extract<LogEvent, { type: "llm-call-start" }>, time?: string): void {
  const role = roleLabel(event.role);
  const title = event.attempt > 1 ? `${role} · attempt ${event.attempt}` : role;
  const view = activityCard("✦", title, "Thinking · preparing context · 0.0s", time);
  view.card.classList.add("activity-live", `activity-${event.role}`);
  view.card.dataset.callId = event.callId;
  const phaseRail = document.createElement("div");
  phaseRail.className = "thinking-rail";
  phaseRail.setAttribute("aria-hidden", "true");
  phaseRail.appendChild(document.createElement("span"));
  // Prompt composition is dev-facing noise — keep it one click away.
  const prompt = document.createElement("details");
  prompt.className = "activity-detail activity-prompt-details";
  const summary = document.createElement("summary");
  summary.textContent = "Prompt composition";
  const content = document.createElement("div");
  content.className = "activity-detail-content";
  content.textContent = promptSummary(event.prompt);
  prompt.append(summary, content);
  view.body.append(phaseRail, prompt);
  const updateElapsed = () => {
    const seconds = Math.max(0, Date.now() - event.startedAt) / 1000;
    const live = liveCallCards.get(event.callId);
    view.status.textContent = live?.outputChars
      ? `Generating · ${formatCompactNumber(live.outputChars)} chars · ${seconds.toFixed(1)}s`
      : `Thinking · preparing context · ${seconds.toFixed(1)}s`;
  };
  const timer = setInterval(updateElapsed, 250);
  liveCallCards.set(event.callId, { card: view.card, status: view.status, timer, outputChars: 0, chunkCount: 0 });
  enqueueNode(view.card);
}

export function updateLLMCallProgress(event: Extract<LogEvent, { type: "llm-call-progress" }>): void {
  const live = liveCallCards.get(event.callId);
  if (!live) return;
  live.outputChars = Math.max(live.outputChars, event.outputChars);
  live.chunkCount = Math.max(live.chunkCount, event.chunkCount);
  live.status.textContent = `Thinking · generating · ${formatCompactNumber(live.outputChars)} chars · ${(event.elapsedMs / 1000).toFixed(1)}s`;
  const body = live.card.querySelector(".activity-body") as HTMLElement | null;
  let stream = body?.querySelector(".activity-stream-progress") as HTMLElement | null;
  if (body && !stream) {
    stream = document.createElement("div");
    stream.className = "activity-stream-progress";
    body.appendChild(stream);
  }
  if (stream) stream.textContent = `${live.chunkCount} live chunks · model is actively reasoning`;
}

export function finishLLMCall(event: Extract<LogEvent, { type: "llm-call-end" }>, time?: string): void {
  const live = liveCallCards.get(event.callId);
  if (!live) {
    const outcome = event.status === "success" ? "Completed" : "Failed";
    const view = activityCard(event.status === "success" ? "●" : "!", roleLabel(event.role), `${outcome} · ${(event.durationMs / 1000).toFixed(1)}s`, time);
    const usage = usageSummary(event);
    if (usage) view.body.textContent = usage;
    if (event.error) addActivityField(view.body, "Error", event.error);
    view.card.classList.add(event.status === "success" ? "activity-complete" : "activity-failed");
    enqueueNode(view.card);
    return;
  }
  clearInterval(live.timer);
  liveCallCards.delete(event.callId);
  live.card.classList.remove("activity-live");
  live.card.classList.add(event.status === "success" ? "activity-complete" : "activity-failed");
  const parseNote = event.parseValid === false ? " · invalid response format" : "";
  live.status.textContent = `${event.status === "success" ? "Completed" : "Failed"} · ${(event.durationMs / 1000).toFixed(1)}s${parseNote}`;
  const body = live.card.querySelector(".activity-body") as HTMLElement | null;
  if (body) {
    const usage = usageSummary(event);
    if (usage) {
      const usageEl = document.createElement("div");
      usageEl.className = "activity-usage";
      usageEl.textContent = usage;
      body.appendChild(usageEl);
    }
    if (event.model) addActivityField(body, "Model", event.model, false);
    if (event.error) addActivityField(body, "Error", event.error);
  }
}

export function addReasoningActivity(event: Extract<LogEvent, { type: "thinking" }>, time?: string): void {
  const view = activityCard("💭", `Thinking · step ${event.step + 1}`, "Model reasoning", time);
  view.card.classList.add("activity-reasoning");
  // The model's chain of thought is the star of the card — show it as primary
  // content instead of burying it inside a <details>.
  if (event.text) {
    const text = document.createElement("div");
    text.className = "activity-reasoning-text";
    text.textContent = safeText(event.text);
    view.body.appendChild(text);
  }
  if (event.nextGoal) {
    const goal = document.createElement("div");
    goal.className = "activity-next-goal";
    goal.textContent = `🎯 ${safeText(event.nextGoal)}`;
    view.body.appendChild(goal);
  }
  // Secondary reasoning context stays one click away (collapsed).
  addActivityField(view.body, "Previous-goal evaluation", event.evaluation, false);
  addActivityField(view.body, "Working memory", event.memory, false);
  enqueueNode(view.card);
}

export function addPlannerActivity(event: Extract<LogEvent, { type: "planner-step" }>, time?: string): void {
  const view = activityCard("◇", `Planner · step ${event.step + 1}`, event.decision, time);
  view.card.classList.add("activity-planner");
  addActivityField(view.body, "Planner reasoning", event.thinking || "");
  addActivityField(view.body, "Next goal", event.goal || "");
  if (event.plan?.length) {
    const plan = document.createElement("ol");
    plan.className = "activity-plan";
    event.plan.forEach((item, index) => {
      const li = document.createElement("li");
      li.textContent = safeText(item);
      if (index === event.currentPlanItem) li.className = "activity-plan-current";
      plan.appendChild(li);
    });
    view.body.appendChild(plan);
  }
  addActivityField(view.body, "Planner answer", event.text || "");
  enqueueNode(view.card);
}

export function addActionActivity(event: Extract<LogEvent, { type: "action" }>, time?: string): void {
  const isVisual = event.name === "inspect_visual" || event.name === "detect_visual";
  const meta = actionMeta(event.name);
  const view = activityCard(meta.icon, `${meta.label} · ${event.index}/${event.total}`, "Running", time);
  view.card.classList.add("activity-tool", "activity-live");
  view.card.style.setProperty("--activity-accent", meta.accent);
  if (isVisual) view.card.classList.add("activity-vision");
  // Resolve the element index from the description (e.g. "click [5]" → [5]) so
  // pointer actions read like "Click element [5]" — a cursor/click log.
  const target = /\[([^\]]+)\]/.exec(event.description ?? "")?.[1];
  const targetLabel = target
    ? target.startsWith("v")
      ? `visual element [${target}]`
      : `element [${target}]`
    : undefined;
  const call = document.createElement("div");
  call.className = "activity-tool-call";
  call.textContent =
    (event.name === "click" || event.name === "hover" || event.name === "press_and_hold")
      ? (targetLabel ?? (event.description || event.name))
      : (event.description || event.name);
  view.body.appendChild(call);
  const key = `${event.step}:${event.name}`;
  const queue = pendingActionCards.get(key) ?? [];
  queue.push(view.card);
  pendingActionCards.set(key, queue);
  enqueueNode(view.card);
}

export function finishActionActivity(event: Extract<LogEvent, { type: "action-result" }>, time?: string): void {
  const key = `${event.step}:${event.name}`;
  const queue = pendingActionCards.get(key);
  const card = queue?.shift();
  if (queue?.length === 0) pendingActionCards.delete(key);
  if (!card) {
    const view = activityCard(event.success ? "✓" : "✕", event.name, event.success ? "Succeeded" : "Failed", time);
    addActivityField(view.body, "Result", event.message);
    view.card.classList.add(event.success ? "activity-complete" : "activity-failed");
    enqueueNode(view.card);
    return;
  }
  card.classList.remove("activity-live");
  card.classList.add(event.success ? "activity-complete" : "activity-failed");
  const status = card.querySelector(".activity-status");
  if (status) status.textContent = event.success ? "Succeeded" : "Failed";
  const body = card.querySelector(".activity-body") as HTMLElement | null;
  if (body) addActivityField(body, "Result", event.message);
}

export function addJudgeActivity(event: Extract<LogEvent, { type: "judge" }>, time?: string): void {
  const status = event.stage === "start" ? "Verifying completion"
    : event.stage === "verdict" ? (event.verdict ? "Verified" : "Rejected") : "Verification failed";
  const existing = pendingJudgeCards.get(event.step);
  if (existing && event.stage !== "start") {
    pendingJudgeCards.delete(event.step);
    existing.classList.remove("activity-live");
    existing.classList.add(event.stage === "error" || event.verdict === false ? "activity-failed" : "activity-complete");
    const statusEl = existing.querySelector(".activity-status");
    if (statusEl) statusEl.textContent = status;
    const body = existing.querySelector(".activity-body") as HTMLElement | null;
    if (body && event.reason) addActivityField(body, "Verdict", event.reason);
    return;
  }
  const view = activityCard("⚖", "Judge", status, time);
  view.card.classList.add(event.stage === "error" || event.verdict === false ? "activity-failed" : "activity-judge");
  if (event.stage === "start") {
    view.card.classList.add("activity-live");
    pendingJudgeCards.set(event.step, view.card);
  }
  if (event.reason) addActivityField(view.body, "Verdict", event.reason);
  enqueueNode(view.card);
}

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

  // Place FAB as sibling of chatMessages, inside the same parent. The parent
  // is the positioned `#chatRegion` wrapper (sidepanel.html), so the button
  // floats at the chat area's bottom edge — never over the status bar.
  chatMessages.parentElement?.appendChild(scrollBtn);

  chatMessages.addEventListener("scroll", (e) => {
    // Only USER-initiated scrolls (wheel/touch/keyboard) flip the pin state.
    // Programmatic scrollTo() calls fire untrusted events — ignoring them keeps
    // an in-progress smooth glide from re-pinning to "user scrolled up".
    if (!e.isTrusted) return;
    const distFromBottom =
      chatMessages.scrollHeight -
      chatMessages.scrollTop -
      chatMessages.clientHeight;
    userScrolledUp = distFromBottom > 100;
    scrollBtn.classList.toggle("visible", userScrolledUp);
  });

  scrollBtn.addEventListener("click", () => {
    userScrolledUp = false;
    // Reduced-motion users get an instant jump instead of a smooth animation.
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    scrollBtn.classList.remove("visible");
  });
}

// Initialize on module load
initScrollBehavior();

/**
 * Keep the feed pinned to the bottom while the user is down there. Glide
 * smoothly when only a little content is below the fold (the common live
 * case), and jump instantly for a giant flush so the panel never chases a
 * long animation. Never overrides an intentional scroll-up.
 */
function scrollToBottom(): void {
  if (userScrolledUp) return;
  const target = chatMessages.scrollHeight;
  const remaining = target - chatMessages.scrollTop - chatMessages.clientHeight;
  if (remaining <= 0) return;
  if (prefersReducedMotion() || remaining > chatMessages.clientHeight * 2) {
    chatMessages.scrollTop = target;
  } else {
    chatMessages.scrollTo({ top: target, behavior: "smooth" });
  }
}

function capNodes(): void {
  while (chatMessages.childElementCount > MAX_CHAT_NODES) {
    const removed = chatMessages.firstElementChild as HTMLElement | null;
    if (!removed) break;
    for (const [callId, live] of liveCallCards) {
      if (live.card === removed) {
        clearInterval(live.timer);
        liveCallCards.delete(callId);
      }
    }
    for (const [key, cards] of pendingActionCards) {
      const retained = cards.filter((card) => card !== removed);
      if (retained.length) pendingActionCards.set(key, retained);
      else pendingActionCards.delete(key);
    }
    for (const [step, card] of pendingJudgeCards) {
      if (card === removed) pendingJudgeCards.delete(step);
    }
    removed.remove();
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
  enqueueNode(el);
}

/** Render the model's user-facing result as safe rich text, exactly once. */
export function addAssistantMessage(text: string, time?: string): void {
  const safe = safeText(text).trim();
  if (!safe || renderedAssistantMessages.has(safe)) return;
  renderedAssistantMessages.add(safe);
  const article = document.createElement("article");
  article.className = "msg-assistant";
  const header = document.createElement("header");
  header.className = "msg-assistant-header";
  const label = document.createElement("strong");
  label.textContent = "Open Cowork";
  header.append(label);
  if (time) {
    const timeEl = document.createElement("time");
    timeEl.textContent = time;
    header.append(timeEl);
  }
  const body = document.createElement("div");
  body.className = "markdown-body";
  body.append(renderSafeMarkdown(safe));
  article.append(header, body);
  addCopyButton(article, safe);
  enqueueNode(article);
}

export function addSystemMessage(
  icon: string,
  text: string,
  variant?: "error" | "warning",
  time?: string,
): void {
  // Agent-sourced strings (error text, takeover reasons, thinking) can embed
  // provider API keys — mask them before anything reaches the DOM.
  text = redactKeyLeak(text);
  const el = document.createElement("div");
  const kindByIcon: Record<string, string> = {
    "▶": "run", "→": "step", "👁": "observation", "⚡": "usage",
    "ℹ": "info", "◉": "vision", "⚠": "warning", "↻": "compaction", "✅": "success",
    "❌": "error", "⏸": "pause", "⏹": "pause", "·": "debug",
  };
  const systemKind = kindByIcon[icon] ?? "event";
  el.className = `msg-system system-${systemKind}` + (variant ? ` msg-${variant}` : "");
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
  enqueueNode(el);
}

export function removeEmptyState(): void {
  const empty = chatMessages.querySelector(".empty-state");
  if (empty) empty.remove();
}
