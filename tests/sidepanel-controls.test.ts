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
  runCount: number;
  lastRunTask: string | null;
  runCallback: SendCb | null;
  sessionStore: Record<string, unknown>;
  localStore: Record<string, unknown>;
  sessionSet: ReturnType<typeof vi.fn>;
}

let st: StubState;

function setupGlobals(): void {
  st = {
    failLocalGet: false,
    runCount: 0,
    lastRunTask: null,
    runCallback: null,
    sessionStore: { apiKey: "sk-test-1234567890" },
    localStore: { provider: "openai" },
    sessionSet: vi.fn(() => Promise.resolve()),
  };
  const chromeStub = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: () => {} },
      sendMessage: (msg: unknown, cb?: SendCb) => {
        const m = msg as { type: string };
        if (m.type === "STATUS") cb?.({ running: false });
        else if (m.type === "RUN") {
          st.runCount++;
          st.lastRunTask = (msg as { task: string }).task;
          st.runCallback = cb ?? null;
        } else if (m.type === "STOP") {
          cb?.({ ok: true });
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
    messageInput().value = "do the thing";
    sendBtn().click();
    await flush();
    expect(st.runCount).toBe(1);
    expect(st.lastRunTask).toBe("do the thing");
  });

  test("debounce holds until the RUN response settles, then clears", async () => {
    await loadControls();
    vi.useFakeTimers();
    const send = (t: string): void => {
      messageInput().value = t;
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
    messageInput().value = "task";
    sendBtn().click();
    await flush();
    expect(chat().textContent).toContain("Send failed");

    // Debounce cleared: a later send works once storage recovers.
    st.failLocalGet = false;
    messageInput().value = "task";
    sendBtn().click();
    await flush();
    expect(st.runCount).toBe(1);
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
    messageInput().value = "task";
    sendBtn().click();
    await flush();
    // The clarify branch is dead: the message must go out as a RUN.
    expect(st.runCount).toBe(1);
    expect(st.sessionSet).not.toHaveBeenCalled();
  });
});
