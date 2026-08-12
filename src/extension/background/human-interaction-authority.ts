/**
 * Background-owned authority for human-interaction prompts.
 *
 * A runtime message is delivered to every open extension page.  Consequently,
 * the content script must never use that message's response channel as the
 * answer to an agent question: two open side panels could otherwise race and
 * leave the losing panel's dialog open.  This broker owns one pending prompt,
 * admits it only for the current run dispatch token, and fans its settlement
 * out to every panel.
 */

import type { HumanInteractionRequest, HumanInteractionResponse } from "@/lib/agent/human-interaction";

export interface HumanInteractionToken {
  runId: string;
  dispatchRevision: number;
}

export interface HumanInteractionPrompt {
  interactionId: string;
  token: HumanInteractionToken;
  request: HumanInteractionRequest;
  timeoutMs: number;
}

interface PendingPrompt extends HumanInteractionPrompt {
  respond: (response: HumanInteractionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HumanInteractionAuthorityDeps {
  canDispatch: (token: HumanInteractionToken) => boolean;
  broadcast: (message: unknown) => void;
}

function tokenKey(token: HumanInteractionToken): string {
  return `${token.runId}:${token.dispatchRevision}`;
}

function promptKey(interactionId: string, token: HumanInteractionToken): string {
  return `${tokenKey(token)}:${interactionId}`;
}

/**
 * The bounded tombstone set closes the cancellation-before-request race and
 * suppresses duplicate/late panel replies without retaining unbounded state in
 * the service worker.
 */
export class HumanInteractionAuthority {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly tombstones = new Set<string>();

  constructor(private readonly deps: HumanInteractionAuthorityDeps) {}

  admit(prompt: HumanInteractionPrompt, respond: (response: HumanInteractionResponse) => void): boolean {
    const key = promptKey(prompt.interactionId, prompt.token);
    if (this.tombstones.has(key)) {
      respond({ mode: "cancelled" });
      return false;
    }
    if (!this.deps.canDispatch(prompt.token)) {
      respond({ mode: "error", reason: "stale or unauthorized HUMAN_INTERACT request" });
      return false;
    }
    if (this.pending.has(key)) {
      respond({ mode: "error", reason: "duplicate HUMAN_INTERACT request" });
      return false;
    }

    const timer = setTimeout(() => {
      this.settle(key, { mode: "cancelled" });
    }, prompt.timeoutMs);
    this.pending.set(key, { ...prompt, respond, timer });
    this.deps.broadcast({ type: "HUMAN_INTERACT_PROMPT", ...prompt });
    return true;
  }

  respond(interactionId: string, token: HumanInteractionToken, response: HumanInteractionResponse): boolean {
    const key = promptKey(interactionId, token);
    const pending = this.pending.get(key);
    if (!pending) return false;
    // A predecessor's panel reply must not be accepted after the successor
    // becomes authoritative.  Settle the old caller as an error and dismiss
    // every panel, rather than leaving an obsolete content callback hanging.
    if (!this.deps.canDispatch(token)) {
      this.settle(key, { mode: "error", reason: "HUMAN_INTERACT authority expired" });
      return false;
    }
    this.settle(key, response);
    return true;
  }

  cancel(interactionId: string, token: HumanInteractionToken): boolean {
    const key = promptKey(interactionId, token);
    this.rememberTombstone(key);
    if (this.pending.has(key)) {
      this.settle(key, { mode: "cancelled" });
      return true;
    }
    // The cancellation may beat the request across runtime message dispatch.
    // Dismiss proactively so a just-opened panel cannot outlive the tombstone.
    this.deps.broadcast({ type: "HUMAN_INTERACT_DISMISS", interactionId, token });
    return false;
  }

  resetForTests(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.tombstones.clear();
  }

  private settle(key: string, response: HumanInteractionResponse): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    this.rememberTombstone(key);
    this.deps.broadcast({
      type: "HUMAN_INTERACT_DISMISS",
      interactionId: pending.interactionId,
      token: pending.token,
    });
    pending.respond(response);
  }

  private rememberTombstone(key: string): void {
    this.tombstones.add(key);
    // Interaction ids are random, but service workers can live a long time.
    // Keep enough tombstones to cover delayed runtime delivery without turning
    // this into a persistent memory sink.
    while (this.tombstones.size > 256) {
      const oldest = this.tombstones.values().next().value as string | undefined;
      if (!oldest) break;
      this.tombstones.delete(oldest);
    }
  }
}
