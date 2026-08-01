/**
 * sidepanel/controls.ts — interrupted-run notice render+consume.
 *
 * When the service worker restarts mid-run while the panel is closed, the
 * startup broadcast is dropped (no listener). The SW now persists the notice
 * to session storage; the panel's STATUS check (fired on open/import) must
 * render it exactly once and remove it.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

function installChrome(notice: string | null): {
  sessionStore: Record<string, unknown>;
} {
  const sessionStore: Record<string, unknown> = {};
  if (notice !== null) sessionStore.open_cowork_interrupted_notice = notice;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: () => {} },
      sendMessage: (_msg: unknown, cb?: (res: unknown) => void) => {
        cb?.({ running: false });
        return Promise.resolve();
      },
    },
    storage: {
      local: {
        get: (_k: unknown, cb: (res: unknown) => void) => cb({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      session: {
        get: (k: unknown, cb: (res: unknown) => void) => {
          const keys = Array.isArray(k) ? k : [k];
          const res: Record<string, unknown> = {};
          for (const key of keys) if (key in sessionStore) res[key] = sessionStore[key];
          cb(res);
        },
        set: (v: Record<string, unknown>) => {
          Object.assign(sessionStore, v);
          return Promise.resolve();
        },
        remove: (k: string | string[]) => {
          const keys = Array.isArray(k) ? k : [k];
          for (const key of keys) delete sessionStore[key];
          return Promise.resolve();
        },
      },
    },
  };
  return { sessionStore };
}

function setupDom(): void {
  document.body.innerHTML = `
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
    <div id="chatMessages"></div>
    <select id="modeSelect"></select>
    <button id="openOptions"></button>
    <div id="statusCenter"></div>
  `;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("interrupted-run notice", () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
  });

  test("renders the persisted notice once on panel open (STATUS check)", async () => {
    const { sessionStore } = installChrome(
      "Service worker was restarted mid-run. The previous run cannot be resumed — please start a new one.",
    );
    await import("../src/extension/sidepanel/controls");
    await flush();
    const chat = document.getElementById("chatMessages") as HTMLElement;
    expect(chat.textContent).toContain("Service worker was restarted mid-run");
    // Consumed: removed from session storage so it can't resurface.
    expect(sessionStore.open_cowork_interrupted_notice).toBeUndefined();
  });

  test("no notice → nothing rendered, nothing removed", async () => {
    const { sessionStore } = installChrome(null);
    await import("../src/extension/sidepanel/controls");
    await flush();
    const chat = document.getElementById("chatMessages") as HTMLElement;
    expect(chat.textContent ?? "").not.toContain("Service worker was restarted");
    expect(sessionStore.open_cowork_interrupted_notice).toBeUndefined();
  });

  test("a fresh run clears the notice before it can render (per-run isolation)", async () => {
    const { sessionStore } = installChrome(
      "Service worker was restarted mid-run. The previous run cannot be resumed — please start a new one.",
    );
    // Simulate the background clearing the notice at run start.
    await chrome.storage.session.remove("open_cowork_interrupted_notice");
    await import("../src/extension/sidepanel/controls");
    await flush();
    const chat = document.getElementById("chatMessages") as HTMLElement;
    expect(chat.textContent ?? "").not.toContain("Service worker was restarted");
    expect(sessionStore.open_cowork_interrupted_notice).toBeUndefined();
  });
});
