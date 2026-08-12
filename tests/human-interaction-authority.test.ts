import { describe, expect, test, vi } from "vitest";
import {
  HumanInteractionAuthority,
  type HumanInteractionToken,
} from "../src/extension/background/human-interaction-authority";

const predecessor: HumanInteractionToken = { runId: "run-1", dispatchRevision: 1 };
const successor: HumanInteractionToken = { runId: "run-2", dispatchRevision: 1 };

function prompt(interactionId = "interaction-1", token = predecessor) {
  return {
    interactionId,
    token,
    request: { mode: "input" as const, message: "What should I enter?" },
    timeoutMs: 1_000,
  };
}

describe("HumanInteractionAuthority", () => {
  test("two panels receive one prompt and the first response dismisses both", () => {
    const active = predecessor;
    const panelOne = { prompts: 0, dismisses: 0 };
    const panelTwo = { prompts: 0, dismisses: 0 };
    const broadcast = vi.fn((message: unknown) => {
      const type = (message as { type?: string }).type;
      for (const panel of [panelOne, panelTwo]) {
        if (type === "HUMAN_INTERACT_PROMPT") panel.prompts += 1;
        if (type === "HUMAN_INTERACT_DISMISS") panel.dismisses += 1;
      }
    });
    const authority = new HumanInteractionAuthority({
      canDispatch: (token) => token.runId === active.runId && token.dispatchRevision === active.dispatchRevision,
      broadcast,
    });
    const respond = vi.fn();

    expect(authority.admit(prompt(), respond)).toBe(true);
    expect(panelOne.prompts).toBe(1);
    expect(panelTwo.prompts).toBe(1);

    expect(authority.respond("interaction-1", predecessor, { mode: "input", value: "first" })).toBe(true);
    expect(authority.respond("interaction-1", predecessor, { mode: "input", value: "late" })).toBe(false);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ mode: "input", value: "first" });
    expect(panelOne.dismisses).toBe(1);
    expect(panelTwo.dismisses).toBe(1);
  });

  test("timeout settles and dismisses every panel", () => {
    vi.useFakeTimers();
    const broadcasts: unknown[] = [];
    const authority = new HumanInteractionAuthority({
      canDispatch: () => true,
      broadcast: (message) => broadcasts.push(message),
    });
    const respond = vi.fn();

    authority.admit(prompt(), respond);
    vi.advanceTimersByTime(1_000);

    expect(respond).toHaveBeenCalledWith({ mode: "cancelled" });
    expect(broadcasts.filter((message) => (message as { type?: string }).type === "HUMAN_INTERACT_DISMISS")).toHaveLength(1);
    vi.useRealTimers();
  });

  test("a cancellation tombstone suppresses a delayed request", () => {
    const broadcasts: unknown[] = [];
    const authority = new HumanInteractionAuthority({ canDispatch: () => true, broadcast: (message) => broadcasts.push(message) });
    const respond = vi.fn();

    expect(authority.cancel("interaction-1", predecessor)).toBe(false);
    expect(authority.admit(prompt(), respond)).toBe(false);

    expect(respond).toHaveBeenCalledWith({ mode: "cancelled" });
    expect(broadcasts.some((message) => (message as { type?: string }).type === "HUMAN_INTERACT_PROMPT")).toBe(false);
  });

  test("a predecessor response is rejected after a successor becomes authoritative", () => {
    let active = predecessor;
    const broadcasts: unknown[] = [];
    const authority = new HumanInteractionAuthority({
      canDispatch: (token) => token.runId === active.runId && token.dispatchRevision === active.dispatchRevision,
      broadcast: (message) => broadcasts.push(message),
    });
    const respond = vi.fn();
    authority.admit(prompt(), respond);
    active = successor;

    expect(authority.respond("interaction-1", predecessor, { mode: "input", value: "stale" })).toBe(false);
    expect(respond).toHaveBeenCalledWith({ mode: "error", reason: "HUMAN_INTERACT authority expired" });
    expect(broadcasts.filter((message) => (message as { type?: string }).type === "HUMAN_INTERACT_DISMISS")).toHaveLength(1);
  });
});
