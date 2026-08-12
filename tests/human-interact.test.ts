/** Side-panel projection tests for background-brokered human interactions. */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  dismissActiveDialog,
  promptConfirm,
  promptText,
  promptPassword,
} from "../src/extension/sidepanel/takeover";

vi.mock("../src/extension/sidepanel/takeover", () => ({
  dismissActiveDialog: vi.fn(),
  promptConfirm: vi.fn(),
  promptText: vi.fn(),
  promptPassword: vi.fn(),
}));

type Sender = { id?: string; tab?: unknown; url?: string };
type Listener = (msg: unknown, sender: Sender, sendResponse: (r: unknown) => void) => unknown;
let listener: Listener | null = null;
let sent: unknown[] = [];

const token = { runId: "run-1", dispatchRevision: 1 };
const prompt = (request: Record<string, unknown>, interactionId = "interaction-1") => ({
  type: "HUMAN_INTERACT_PROMPT",
  interactionId,
  token,
  request,
});

function setupGlobals(): void {
  sent = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      id: "test",
      onMessage: { addListener: (cb: Listener) => { listener = cb; } },
      sendMessage: (message: unknown) => { sent.push(message); return Promise.resolve(); },
    },
    storage: { local: { get: () => {}, set: () => Promise.resolve(), remove: () => Promise.resolve() } },
  };
  document.body.innerHTML = `
    <div id="chatMessages"></div><input id="messageInput" /><button id="sendBtn"></button>
    <button id="stopBtn"></button><span id="costLabel">$0.0000</span><span id="tokenLabel">0 tokens</span>
    <span id="statusDot" data-status="idle"></span><span id="statusLabel">idle</span>
    <div id="takeoverBanner" hidden></div><div id="takeoverReason"></div><button id="resumeBtn"></button>`;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  setupGlobals();
  await import("../src/extension/sidepanel/human-interact");
});

describe("parseHumanRequest", () => {
  test("requires an interaction identity and run token", async () => {
    const { parseHumanRequest } = await import("../src/extension/sidepanel/human-interact");
    expect(parseHumanRequest({ interactionId: "i", request: { mode: "input" } })).toBeNull();
    expect(parseHumanRequest({ interactionId: "i", token, request: { mode: 123 } })).toBeNull();
  });

  test("keeps a valid prompt's token and default value", async () => {
    const { parseHumanRequest } = await import("../src/extension/sidepanel/human-interact");
    expect(parseHumanRequest(prompt({ mode: "input", message: "Email?", defaultValue: "me@example.com" }))).toEqual({
      interactionId: "interaction-1",
      token,
      mode: "input",
      message: "Email?",
      defaultValue: "me@example.com",
    });
  });
});

describe("HUMAN_INTERACT_PROMPT listener", () => {
  test("forwards the first panel's confirm answer to the background broker", async () => {
    vi.mocked(promptConfirm).mockResolvedValue(true);
    expect(listener!(prompt({ mode: "confirm", message: "Continue?" }), { id: "test" }, vi.fn())).toBe(false);
    await flush();
    expect(sent).toContainEqual({
      type: "HUMAN_INTERACT_RESPONSE",
      interactionId: "interaction-1",
      token,
      response: { mode: "confirm", confirmed: true },
    });
  });

  test("forwards input/password cancellation and preserves default input", async () => {
    vi.mocked(promptText).mockResolvedValue(null);
    listener!(prompt({ mode: "input", message: "Email?", defaultValue: "pre" }), { id: "test" }, vi.fn());
    await flush();
    expect(promptText).toHaveBeenCalledWith("Email?", "pre");
    expect(sent.at(-1)).toEqual(expect.objectContaining({ response: { mode: "cancelled" } }));

    vi.mocked(promptPassword).mockResolvedValue("secret");
    listener!(prompt({ mode: "password", message: "Password?" }, "interaction-2"), { id: "test" }, vi.fn());
    await flush();
    expect(sent.at(-1)).toEqual(expect.objectContaining({
      interactionId: "interaction-2",
      // Password responses are tagged `password` (not `input`) so callers can
      // distinguish a secret and never copy it into history/logs unredacted.
      response: { mode: "password", value: "secret" },
    }));
  });

  test("a broker dismiss broadcast closes this panel's matching dialog", () => {
    vi.mocked(promptConfirm).mockReturnValue(new Promise(() => {}));
    listener!(prompt({ mode: "confirm", message: "Continue?" }), { id: "test" }, vi.fn());
    listener!(
      { type: "HUMAN_INTERACT_DISMISS", interactionId: "interaction-1", token },
      { id: "test" },
      vi.fn(),
    );
    expect(dismissActiveDialog).toHaveBeenCalledTimes(1);
  });

  test("rejects content-originated prompt injection", () => {
    const response = vi.fn();
    expect(listener!(prompt({ mode: "confirm", message: "x" }), { id: "test", tab: { id: 1 } }, response)).toBe(false);
    expect(promptConfirm).not.toHaveBeenCalled();
    expect(response).not.toHaveBeenCalled();
  });
});
