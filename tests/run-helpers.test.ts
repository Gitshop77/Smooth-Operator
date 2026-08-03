/**
 * run-helpers.ts — `buildLoopDeps().executeActions` mode/confirmation gate.
 *
 * `executeActions` is the ONLY enforcement point for mode restrictions
 * (`checkActionAllowed`) and confirmation prompts (`requiresConfirmation` →
 * `askHuman`) in the extension path — when deps.executeActions is provided
 * (which it always is in the extension), the orchestrator's built-in
 * executeActionQueue is bypassed. It must (a) BLOCK disallowed actions, (b)
 * BLOCK actions the user declines to confirm, and (c) return exactly one
 * ActionResult per input action so the orchestrator's per-action history
 * alignment holds. These are the security-relevant guarantees.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Drive the mode/confirmation gate deterministically. The real `modes` module
// is heavily gated (no mode currently yields an allowed *and* confirm-required
// action), so we mock it to exercise both branches in isolation.
vi.mock("@/lib/agent/modes", () => ({
  checkActionAllowed: vi.fn(),
  requiresConfirmation: vi.fn(),
}));
vi.mock("@/lib/agent/human-interaction", () => ({
  askHuman: vi.fn(),
}));

import { buildLoopDeps } from "../src/extension/background/run-helpers";
import { RUN_STATE_KEY } from "../src/extension/background/state-store";
import { checkActionAllowed, requiresConfirmation } from "@/lib/agent/modes";
import { askHuman } from "@/lib/agent/human-interaction";
import type { AgentAction } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";

let sessionStore: Record<string, unknown> = {};
let chromeMock: {
  tabs: { sendMessage: ReturnType<typeof vi.fn> };
  storage: { session: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } };
};

function installChrome(): void {
  sessionStore = {};
  const sendMessage = vi.fn(async (_tabId: number, msg: { type?: string; actions?: AgentAction[] }) => {
    if (msg?.type === "PING") return { ok: true };
    if (msg?.type === "EXECUTE_ACTIONS") {
      const acts = msg.actions ?? [];
      return {
        ok: true,
        results: acts.map((a) => ({ action: a, success: true, message: "ok" })),
      };
    }
    return { ok: true };
  });
  chromeMock = {
    tabs: { sendMessage },
    storage: {
      session: {
        get: vi.fn(async (key: unknown) => {
          if (typeof key === "string") return { [key]: sessionStore[key] };
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) out[k] = sessionStore[k];
            return out;
          }
          return { ...sessionStore };
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(sessionStore, obj);
        }),
        remove: vi.fn(async (key: string) => {
          delete sessionStore[key];
        }),
      },
    },
  };
  (globalThis as Record<string, unknown>).chrome = chromeMock;
}

function setRunState(mode: AgentMode): void {
  sessionStore[RUN_STATE_KEY] = {
    task: "t",
    maxSteps: 10,
    mode,
    startTabId: 1,
    currentTabId: 1,
    step: 0,
    active: true,
    abortRequested: false,
  };
}

function makeExecuteActions(mode: AgentMode) {
  setRunState(mode);
  const deps = buildLoopDeps({
    tab: { id: 1 } as unknown as chrome.tabs.Tab,
    sendEvent: vi.fn(),
    controller: new AbortController(),
    config: { maxSteps: 10, maxActionsPerStep: 10, plannerInterval: 1, maxFailures: 1, costCapUsd: 0 },
    task: "task",
    mode,
  });
  return deps.executeActions!;
}

beforeEach(() => {
  installChrome();
  (checkActionAllowed as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({ allowed: true }));
  (requiresConfirmation as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => false);
  (askHuman as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: "confirm", confirmed: true });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.clearAllMocks();
});

describe("executeActions mode/confirmation gate", () => {
  test("a blocked action BLOCKS itself and aligns all subsequent actions", async () => {
    (checkActionAllowed as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "evaluate" ? { allowed: false, reason: "eval blocked" } : { allowed: true }),
    );
    const executeActions = makeExecuteActions("restricted");
    const actions: AgentAction[] = [
      { type: "evaluate" },
      { type: "click", index: 0 },
      { type: "input_text", text: "x" },
    ] as AgentAction[];
    const results = await executeActions(actions, {} as never);
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/BLOCKED/);
    }
    // The content script must NOT have been messaged — nothing was forwarded.
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "EXECUTE_ACTIONS" }),
    );
  });

  test("a confirm-required action declined by the user is BLOCKED", async () => {
    (requiresConfirmation as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => type === "evaluate",
    );
    (askHuman as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: "confirm", confirmed: false });
    const executeActions = makeExecuteActions("standard");
    const actions: AgentAction[] = [{ type: "evaluate" } as AgentAction];
    const results = await executeActions(actions, {} as never);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/BLOCKED/);
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "EXECUTE_ACTIONS" }),
    );
  });

  test("a confirm-required action confirmed by the user is forwarded and slotted back in order", async () => {
    (requiresConfirmation as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => type === "evaluate",
    );
    (askHuman as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: "confirm", confirmed: true });
    const executeActions = makeExecuteActions("standard");
    const actions: AgentAction[] = [{ type: "evaluate" } as AgentAction];
    const results = await executeActions(actions, {} as never);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "EXECUTE_ACTIONS" }),
    );
  });

  test("a leading run of allowed actions executes; a blocked tail is aligned", async () => {
    (checkActionAllowed as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (type: string) => (type === "evaluate" ? { allowed: false, reason: "eval blocked" } : { allowed: true }),
    );
    const executeActions = makeExecuteActions("restricted");
    const actions: AgentAction[] = [
      { type: "click", index: 0 },
      { type: "click", index: 1 },
      { type: "evaluate" },
      { type: "click", index: 2 },
    ] as AgentAction[];
    const results = await executeActions(actions, {} as never);
    expect(results.length).toBe(4);
    // Leading click batch was forwarded and succeeded.
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    // The blocked action and everything after it align to BLOCKED.
    expect(results[2].success).toBe(false);
    expect(results[2].message).toMatch(/BLOCKED/);
    expect(results[3].success).toBe(false);
    expect(results[3].message).toMatch(/BLOCKED: prior action/);
  });

  test("a throwing content-script round-trip yields per-action failures (queue not truncated)", async () => {
    // The content script is unreachable: sendMessage resolves with ok:false,
    // which makes executeActionsInTab THROW. executeActions must catch that
    // and mark every forwarded action failed instead of rejecting — the
    // mirror of the loop-side safeDispatch guard.
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId: number, msg: { type?: string }) => {
      if (msg?.type === "PING") return { ok: true };
      return { ok: false, error: "content script not ready" };
    });
    const executeActions = makeExecuteActions("standard");
    const actions: AgentAction[] = [
      { type: "click", index: 0 },
      { type: "click", index: 1 },
    ] as AgentAction[];

    const results = await executeActions(actions, {} as never);

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/BLOCKED: content script failed/);
    }
  });
});
