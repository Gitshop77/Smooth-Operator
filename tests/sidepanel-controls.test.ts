/**
 * sidepanel/controls.ts — send/stop/shortcut behavior.
 *
 * Covers: the `/` shortcut must not swallow keystrokes inside inputs, the
 * send debounce must stay armed until the RUN response settles, a send
 * rejection must surface to the user, and the dead clarify branch must not
 * intercept sends.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

type SendCb = (res: unknown) => void;

interface StubState {
  failLocalGet: boolean;
  failRunSend: boolean;
  runCount: number;
  lastRunTask: string | null;
  runCallback: SendCb | null;
  sessionStore: Record<string, unknown>;
  localStore: Record<string, unknown>;
  sessionSet: ReturnType<typeof vi.fn>;
  statusResponses: unknown[];
  stopResponse: unknown;
}

let st: StubState;

function setupGlobals(): void {
  st = {
    failLocalGet: false,
    failRunSend: false,
    runCount: 0,
    lastRunTask: null,
    runCallback: null,
    sessionStore: { apiKey: "sk-test-1234567890" },
    localStore: { provider: "openai" },
    sessionSet: vi.fn(() => Promise.resolve()),
    statusResponses: [{ running: false }],
    stopResponse: { ok: true, status: "cancelling" },
  };
  const chromeStub = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: () => {} },
      sendMessage: (msg: unknown, cb?: SendCb) => {
        const m = msg as { type: string };
        if (m.type === "STATUS") cb?.(st.statusResponses.length ? st.statusResponses.shift() : { running: false });
        else if (m.type === "RUN") {
          st.runCount++;
          st.lastRunTask = (msg as { task: string }).task;
          if (st.failRunSend) {
            (chromeStub.runtime as { lastError?: { message: string } }).lastError = {
              message: "Extension context invalidated.",
            };
            cb?.(undefined);
            (chromeStub.runtime as { lastError?: { message: string } }).lastError = undefined;
          } else {
            st.runCallback = cb ?? null;
          }
        } else if (m.type === "STOP") {
          cb?.(st.stopResponse);
        } else {
          cb?.(undefined);
        }
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        get: (k: unknown, cb?: (res: Record<string, unknown>) => void) => {
          if (st.failLocalGet) {
            (chromeStub.runtime as { lastError?: { message: string } }).lastError = {
              message: "storage exploded",
            };
            if (cb) cb({});
            (chromeStub.runtime as { lastError?: { message: string } }).lastError = undefined;
            return;
          }
          const keys = Array.isArray(k) ? k : [k];
          const res: Record<string, unknown> = {};
          for (const key of keys) if (key in st.localStore) res[key] = st.localStore[key];
          if (cb) cb(res);
          else return Promise.resolve(res);
        },
        set: (v: Record<string, unknown>) => {
          Object.assign(st.localStore, v);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      session: {
        get: (k: unknown, cb?: (res: Record<string, unknown>) => void) => {
          const keys = Array.isArray(k) ? k : [k];
          const res: Record<string, unknown> = {};
          for (const key of keys) if (key in st.sessionStore) res[key] = st.sessionStore[key];
          if (cb) cb(res);
          else return Promise.resolve(res);
        },
        set: st.sessionSet,
        remove: () => Promise.resolve(),
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

  document.body.innerHTML = `
    <div id="chatMessages"><div class="empty-state"></div></div>
    <textarea id="messageInput"></textarea>
    <button id="sendBtn"></button>
    <button id="stopBtn"></button>
    <button id="pauseBtn"><span>Pause</span></button>
    <span id="costLabel">$0.0000</span>
    <span id="tokenLabel">0 tokens</span>
    <span id="statusDot" data-status="idle"></span>
    <span id="statusLabel">idle</span>
    <div id="takeoverBanner" hidden></div>
    <div id="takeoverReason"></div>
    <button id="resumeBtn"></button>
    <select id="modeSelect"></select>
    <button id="openOptions"></button>
    <div id="statusCenter"></div>
  `;
}

async function loadControls(): Promise<void> {
  await import("../src/extension/sidepanel/controls");
}

function messageInput(): HTMLTextAreaElement {
  return document.getElementById("messageInput") as HTMLTextAreaElement;
}

function setTask(value: string): void {
  messageInput().value = value;
  messageInput().dispatchEvent(new Event("input", { bubbles: true }));
}

function sendBtn(): HTMLButtonElement {
  return document.getElementById("sendBtn") as HTMLButtonElement;
}

function chat(): HTMLElement {
  return document.getElementById("chatMessages") as HTMLElement;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("sidepanel controls", () => {
  beforeEach(() => {
    vi.resetModules();
    setupGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("send issues a RUN with the typed task", async () => {
    await loadControls();
    setTask("do the thing");
    sendBtn().click();
    await flush();
    expect(st.runCount).toBe(1);
    expect(st.lastRunTask).toBe("do the thing");
  });

  test("debounce holds until the RUN response settles, then clears", async () => {
    await loadControls();
    vi.useFakeTimers();
    const send = (t: string): void => {
      setTask(t);
      sendBtn().click();
    };

    send("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(st.runCount).toBe(1);

    // Second send while the RUN is still pending is dropped.
    send("second");
    await vi.advanceTimersByTimeAsync(0);
    expect(st.runCount).toBe(1);

    // Past the old 500ms window the guard must STILL hold — the response
    // has not settled yet.
    await vi.advanceTimersByTimeAsync(600);
    send("third");
    await vi.advanceTimersByTimeAsync(0);
    expect(st.runCount).toBe(1);

    // Once the RUN response settles, the debounce clears and sends work again.
    st.runCallback?.({ ok: false, error: "nope" });
    await vi.advanceTimersByTimeAsync(0);
    send("fourth");
    await vi.advanceTimersByTimeAsync(0);
    expect(st.runCount).toBe(2);
  });

  test("a rejected send surfaces an error message and clears the debounce", async () => {
    await loadControls();
    st.failLocalGet = true;
    setTask("task");
    sendBtn().click();
    await flush();
    expect(chat().textContent).toContain("Send failed");

    // Debounce cleared: a later send works once storage recovers.
    st.failLocalGet = false;
    setTask("task");
    sendBtn().click();
    await flush();
    expect(st.runCount).toBe(1);
  });

  test("a rejected RUN send cancels the in-flight timeout instead of double-reporting", async () => {
    vi.useFakeTimers();
    await loadControls();
    st.failRunSend = true;
    setTask("task");
    sendBtn().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat().textContent).toContain("Send failed");
    // The 10s RUN fallback must be cancelled by the catch path — otherwise a
    // second, misleading "No response from background" error would clobber the
    // real failure already shown above.
    await vi.advanceTimersByTimeAsync(10_100);
    expect(chat().textContent).toContain("Send failed");
    expect(chat().textContent).not.toContain("No response from background");
  });

  test("/ shortcut does not fire inside inputs or textareas", async () => {
    await loadControls();
    for (const tag of ["input", "textarea"]) {
      const tmp = document.createElement(tag);
      document.body.appendChild(tmp);
      tmp.focus();

      const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
      tmp.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(tmp);

      tmp.remove();
    }
  });

  test("/ shortcut focuses the message input when nothing editable is focused", async () => {
    await loadControls();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(messageInput());
  });

  test("/ shortcut is suppressed with a modifier held", async () => {
    await loadControls();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const ev = new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("a stale clarify flag in session storage is ignored", async () => {
    st.sessionStore.open_cowork_clarify = "pending-question";
    await loadControls();
    setTask("task");
    sendBtn().click();
    await flush();
    // The clarify branch is dead: the message must go out as a RUN.
    expect(st.runCount).toBe(1);
    expect(st.sessionSet).not.toHaveBeenCalled();
  });

  test("terminal STATUS snapshot restores the result and leaves blank Send disabled", async () => {
    st.statusResponses = [{
      running: false,
      snapshot: {
        version: 1, runId: "done-1", revision: 3, dispatchRevision: 2,
        task: "summarize", maxSteps: 10, mode: "standard", status: "succeeded",
        phase: "terminal", step: 2, startedAt: 1, updatedAt: 2, endedAt: 2,
        terminalMessage: "Completed", resultText: "A concise answer",
      },
    }];
    await loadControls();
    await flush();
    expect(chat().textContent).toContain("A concise answer");
    expect(sendBtn().disabled).toBe(true);

    setTask("follow up");
    expect(sendBtn().disabled).toBe(false);
    sendBtn().click();
    await flush();
    expect(st.runCount).toBe(1);
  });

  test("an event reconciles a previously hydrated running snapshot to terminal", async () => {
    const active = {
      version: 1, runId: "event-run", revision: 1, dispatchRevision: 1,
      task: "task", maxSteps: 10, mode: "standard", status: "running",
      phase: "reasoning", step: 1, startedAt: 1, updatedAt: 1,
    };
    const terminal = {
      ...active, revision: 2, dispatchRevision: 2, status: "succeeded",
      phase: "terminal", updatedAt: 2, endedAt: 2,
      terminalMessage: "Completed", resultText: "Authoritative result",
    };
    st.statusResponses = [{ running: true, snapshot: active }];
    const controls = await import("../src/extension/sidepanel/controls");
    await flush();
    expect(document.querySelector(".empty-state")).toBeNull();

    st.statusResponses = [{ running: false, snapshot: terminal }];
    controls.onAgentEvent();
    await flush();
    await flush();

    expect(chat().textContent).toContain("Authoritative result");
    expect(messageInput().disabled).toBe(false);
  });

  test("Stop enters cancelling immediately and reconciles its terminal snapshot", async () => {
    vi.useFakeTimers();
    const active = {
      version: 1, runId: "active-1", revision: 1, dispatchRevision: 1,
      task: "task", maxSteps: 10, mode: "standard", status: "running",
      phase: "reasoning", step: 1, startedAt: 1, updatedAt: 1,
    };
    const cancelling = { ...active, revision: 2, dispatchRevision: 2, status: "cancelling", phase: "cancelling" };
    const terminal = { ...cancelling, revision: 3, status: "cancelled", phase: "terminal", terminalMessage: "Cancelled", endedAt: 3 };
    st.statusResponses = [{ running: true, snapshot: active }, { running: false, snapshot: terminal }];
    st.stopResponse = { ok: true, status: "cancelling", snapshot: cancelling };
    await loadControls();
    await vi.advanceTimersByTimeAsync(0);
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    stop.click();
    // Flush the chat renderer's microtask-batched append.
    await vi.advanceTimersByTimeAsync(0);
    expect(chat().textContent).toContain("Cancellation requested immediately");
    expect(stop.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(125);
    expect(chat().textContent).toContain("Cancelled");
    expect(document.getElementById("statusLabel")?.textContent).toBe("Cancelled");
    expect(stop.disabled).toBe(true);
  });

  test("session snapshot changes move an already-open panel to a successor run", async () => {
    await loadControls();
    const { handleRunSnapshotStorageChange } = await import("../src/extension/sidepanel/controls");
    const successor = {
      version: 1,
      runId: "run-b",
      revision: 1,
      dispatchRevision: 1,
      task: "Successor task",
      maxSteps: 2,
      mode: "standard",
      status: "starting",
      phase: "starting",
      step: 0,
      startedAt: 20,
      updatedAt: 20,
    };

    expect(handleRunSnapshotStorageChange({
      open_cowork_run_snapshot_v1: { newValue: successor },
    }, "session")).toBe(true);
    expect(document.getElementById("statusLabel")?.textContent).toBe("Thinking…");
    expect((document.getElementById("stopBtn") as HTMLButtonElement).disabled).toBe(false);
    expect(handleRunSnapshotStorageChange({
      open_cowork_run_snapshot_v1: { newValue: successor },
    }, "local")).toBe(false);
  });

  test("Pause button sets the manual-pause flag and toggles to Resume", async () => {
    await loadControls();
    const { handleRunSnapshotStorageChange } = await import("../src/extension/sidepanel/controls");
    const running = {
      version: 1, runId: "run-pause", revision: 1, dispatchRevision: 1,
      task: "task", maxSteps: 10, mode: "standard", status: "running",
      phase: "acting", step: 1, startedAt: 1, updatedAt: 1,
    };
    expect(handleRunSnapshotStorageChange({ open_cowork_run_snapshot_v1: { newValue: running } }, "session")).toBe(true);
    const pause = document.getElementById("pauseBtn") as HTMLButtonElement;
    expect(pause.disabled).toBe(false);
    expect(pause.textContent).toContain("Pause");

    pause.click();
    await flush();
    expect(st.sessionSet).toHaveBeenCalledWith({ open_cowork_paused: true });
    expect(pause.textContent).toContain("Resume");
    expect(pause.getAttribute("aria-label")).toBe("Resume agent");

    // Click again to resume: the flag is cleared.
    pause.click();
    await flush();
    expect(st.sessionSet).toHaveBeenLastCalledWith({ open_cowork_paused: false });
    expect(pause.textContent).toContain("Pause");
  });
  test("idle Stop response is explicit rather than pretending to cancel", async () => {
    await loadControls();
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    // A run can finish between the last render and the click; emulate that race.
    stop.disabled = false;
    st.stopResponse = { ok: true, status: "idle" };
    stop.click();
    await flush();
    expect(chat().textContent).toContain("No active run to cancel");
  });

  test("Stop exposes an actionable timeout when cancellation remains unconfirmed", async () => {
    vi.useFakeTimers();
    const active = {
      version: 1, runId: "active-timeout", revision: 1, dispatchRevision: 1,
      task: "task", maxSteps: 10, mode: "standard", status: "running",
      phase: "acting", step: 1, startedAt: 1, updatedAt: 1,
    };
    const cancelling = { ...active, revision: 2, dispatchRevision: 2, status: "cancelling", phase: "cancelling" };
    st.statusResponses = [
      { running: true, snapshot: active },
      ...Array.from({ length: 5 }, () => ({ running: true, snapshot: cancelling })),
    ];
    st.stopResponse = { ok: true, status: "cancelling", snapshot: cancelling };
    await loadControls();
    await vi.advanceTimersByTimeAsync(0);
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    stop.click();
    // Each bounded poll confirms only the same cancelling snapshot, so the UI
    // must expose the retry affordance instead of waiting forever.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(chat().textContent).toContain("Cancellation has not been confirmed");
    expect(stop.disabled).toBe(false);
  });

  test("message input auto-grows for multi-line prompts and shrinks when cleared", async () => {
    await loadControls();
    const input = messageInput();

    // jsdom cannot lay out real content, so emulate a tall prompt via the
    // scrollHeight the browser would report.
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 300 });
    setTask("line one\nline two\nline three");
    // 300px of content exceeds any 6-row cap (≥48px), so the input must clamp.
    expect(input.style.overflowY).toBe("auto");
    expect(Number.parseInt(input.style.height, 10)).toBeLessThan(300);

    // Clearing the task resizes back down to fit the (empty) content — the
    // height always equals the content height below the 48px floor.
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 20 });
    setTask("");
    expect(input.style.overflowY).toBe("hidden");
    expect(input.style.height).toBe("20px");
  });
});
