/**
 * sidepanel/takeover.ts — takeover banner + in-panel modal behavior.
 *
 * Covers the modal lifecycle contract: an open dialog is ALWAYS settled when
 * the overlay is removed (run end, banner hide, replacement dialog), with its
 * cancel value — never left dangling (the agent loop's askHuman would stall
 * until its 5-minute timeout) and never resolved to a transport-error shape.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from "vitest";

type Listener = (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => unknown;

let sessionSet: ReturnType<typeof vi.fn>;

function setupGlobals(): void {
  sessionSet = vi.fn(() => Promise.resolve());
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: (_cb: Listener) => {} },
      sendMessage: (_msg: unknown, cb?: (res: unknown) => void) => {
        cb?.({ ok: true });
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
        get: (_k: unknown, cb: (res: unknown) => void) => cb({}),
        set: sessionSet,
        remove: () => Promise.resolve(),
      },
    },
  };

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
    <div id="statusCenter"></div>
  `;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("sidepanel takeover modals", () => {
  let promptConfirm: (m: string) => Promise<unknown>;
  let promptText: (m: string, init: string) => Promise<unknown>;
  let promptPassword: (m: string) => Promise<unknown>;
  let showTakeoverBanner: (reason: string) => void;
  let hideTakeoverBanner: () => void;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/sidepanel/takeover");
    promptConfirm = mod.promptConfirm;
    promptText = mod.promptText;
    promptPassword = mod.promptPassword;
    showTakeoverBanner = mod.showTakeoverBanner;
    hideTakeoverBanner = mod.hideTakeoverBanner;
  });

  beforeEach(() => {
    document.querySelector(".password-prompt-overlay")?.remove();
    const banner = document.getElementById("takeoverBanner") as HTMLElement;
    banner.hidden = true;
    const reason = document.getElementById("takeoverReason") as HTMLElement;
    reason.textContent = "";
  });

  test("hideTakeoverBanner settles an open confirm dialog with cancel (false)", async () => {
    const p = promptConfirm("Proceed?");
    await flush();
    expect(document.querySelector(".password-prompt-overlay")).not.toBeNull();
    hideTakeoverBanner();
    await expect(p).resolves.toBe(false);
    expect(document.querySelector(".password-prompt-overlay")).toBeNull();
  });

  test("hideTakeoverBanner settles an open text dialog with cancel (null)", async () => {
    const p = promptText("Email?", "");
    await flush();
    hideTakeoverBanner();
    await expect(p).resolves.toBeNull();
  });

  test("hideTakeoverBanner settles an open password dialog with cancel (null)", async () => {
    const p = promptPassword("Password?");
    await flush();
    hideTakeoverBanner();
    await expect(p).resolves.toBeNull();
  });

  test("a replacement dialog settles the previous one with its cancel value", async () => {
    const first = promptConfirm("First?");
    await flush();
    const second = promptConfirm("Second?");
    // The first prompt resolves as a cancel (false) — not null, not dangling.
    await expect(first).resolves.toBe(false);
    // The second stays open until dismissed.
    expect(document.querySelector(".password-prompt-overlay")).not.toBeNull();
    hideTakeoverBanner();
    await expect(second).resolves.toBe(false);
  });

  test("showTakeoverBanner shows the reason and enables Resume", () => {
    showTakeoverBanner("need login");
    const banner = document.getElementById("takeoverBanner") as HTMLElement;
    const reason = document.getElementById("takeoverReason") as HTMLElement;
    const resume = document.getElementById("resumeBtn") as HTMLButtonElement;
    expect(banner.hidden).toBe(false);
    expect(reason.textContent).toBe("need login");
    expect(resume.disabled).toBe(false);
  });

  test("showTakeoverBanner does not steal focus from an open modal", async () => {
    const p = promptPassword("Pass:");
    await flush();
    const input = document.querySelector(".password-prompt-overlay input") as HTMLInputElement;
    input.focus();
    showTakeoverBanner("still waiting");
    expect(document.activeElement).toBe(input);
    hideTakeoverBanner();
    await expect(p).resolves.toBeNull();
  });

  test("RESUME success does not write the dead pause flag", async () => {
    const resume = document.getElementById("resumeBtn") as HTMLButtonElement;
    resume.click();
    await flush();
    expect(sessionSet).not.toHaveBeenCalled();
  });
});
