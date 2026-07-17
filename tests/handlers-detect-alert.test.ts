/**
 * Regression coverage for the `detect_visual` handler (timeout race + boolean
 * `ok` guard) and the redaction paths of the `alert_*` / `ask_human` handlers.
 *
 * The `detect_visual` flow guards against a hung/crashed service worker (a 30s
 * `Promise.race` timeout) and validates the SW response shape with a strict
 * boolean `ok` check — both are non-trivial control flow with no test until
 * now. The alert/ask-human handlers redact dialog text, staged prompt
 * credentials, and password-mode answers via `redactDialogText` before the
 * values are replayed into LLM prompts and persisted to run-history; a
 * regression there would silently leak secrets.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { handleDetectVisual } from "../src/lib/agent/tools/handlers/detect-visual";
import {
  handleAlertGetText,
  handleAlertAccept,
  handleAlertDismiss,
  handleAlertSendKeys,
} from "../src/lib/agent/tools/handlers/alert";
import { handleAskHuman } from "../src/lib/agent/tools/handlers/ask-human";
import * as popupMod from "../src/lib/agent/dom/popup-handler";

// Keep the REAL `redactDialogText` (so the tests assert genuine redaction), but
// stub the dialog-state accessors / mutators the handlers call.
vi.mock("../src/lib/agent/dom/popup-handler", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/agent/dom/popup-handler")>(
    "../src/lib/agent/dom/popup-handler",
  );
  return {
    ...actual,
    getPendingAlertText: vi.fn(() => "OTP is 000999 and password is hunter2"),
    getPendingAlertKind: vi.fn(() => "alert"),
    acceptAlert: vi.fn(() => {}),
    dismissAlert: vi.fn(() => {}),
    sendAlertText: vi.fn(() => {}),
    stagePromptText: vi.fn(() => {}),
  };
});

// Stub askHuman so the password-mode redaction branch is exercisable.
vi.mock("../src/lib/agent/human-interaction", () => ({
  askHuman: vi.fn(async () => ({ mode: "password", value: "supersecretpw123" })),
}));

const DUMMY_CTX = {} as ActionContext;

const getPendingAlertText = vi.mocked(popupMod.getPendingAlertText);
const getPendingAlertKind = vi.mocked(popupMod.getPendingAlertKind);
const acceptAlert = vi.mocked(popupMod.acceptAlert);
const dismissAlert = vi.mocked(popupMod.dismissAlert);

beforeEach(() => {
  getPendingAlertText.mockReturnValue("OTP is 000999 and password is hunter2");
  getPendingAlertKind.mockReturnValue("alert");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
});

function installExtensionMock(sendMessage: (msg: unknown) => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-id", sendMessage },
  };
}

// ─── detect_visual ─────────────────────────────────────────────────────────

describe("handleDetectVisual", () => {
  test("success when the SW returns { ok:true, count, description }", async () => {
    installExtensionMock(async () => ({ ok: true, count: 3, description: "three boxes" }));
    const res = await handleDetectVisual(DUMMY_CTX, {
      type: "detect_visual",
      query: "find buttons",
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toBe("three boxes");
  });

  test("failure when the SW returns { ok:false, error }", async () => {
    installExtensionMock(async () => ({ ok: false, error: "model offline" }));
    const res = await handleDetectVisual(DUMMY_CTX, {
      type: "detect_visual",
      query: "q",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("model offline");
  });

  test("failure when ok is a non-boolean (malformed SW response)", async () => {
    installExtensionMock(async () => ({ ok: "yes" as unknown as boolean, count: 1 }));
    const res = await handleDetectVisual(DUMMY_CTX, {
      type: "detect_visual",
      query: "q",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("detect_visual failed");
  });

  test("failure when the SW response is missing/undefined", async () => {
    installExtensionMock(async () => undefined);
    const res = await handleDetectVisual(DUMMY_CTX, {
      type: "detect_visual",
      query: "q",
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("no response from extension");
  });

  test("returns a failure (and honours the timeout) when the SW never responds", async () => {
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn(() => new Promise<never>(() => {}));
      installExtensionMock(sendMessage);
      const p = handleDetectVisual(DUMMY_CTX, { type: "detect_visual", query: "q" });
      await vi.advanceTimersByTimeAsync(30000);
      const res = await p;
      expect(res.success).toBe(false);
      expect(res.message).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── alert_* redaction ───────────────────────────────────────────────────────

describe("alert_* redaction", () => {
  const SECRET = "OTP is 000999 and password is hunter2";

  test("handleAlertGetText redacts the dialog text (no secret in message/extractedContent)", async () => {
    const res = await handleAlertGetText(DUMMY_CTX, { type: "alert_get_text" });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toBe(`${SECRET.length} char(s) (redacted)`);
    expect(res.message).not.toContain("000999");
    expect(res.message).not.toContain("hunter2");
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });

  test("handleAlertAccept redacts the dialog text after accepting", async () => {
    const res = await handleAlertAccept(DUMMY_CTX, { type: "alert_accept" });
    expect(res.success).toBe(true);
    expect(acceptAlert).toHaveBeenCalled();
    expect(res.message).toContain("Accepted JS dialog:");
    expect(res.message).not.toContain("hunter2");
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });

  test("handleAlertDismiss redacts the dialog text after dismissing", async () => {
    const res = await handleAlertDismiss(DUMMY_CTX, { type: "alert_dismiss" });
    expect(res.success).toBe(true);
    expect(dismissAlert).toHaveBeenCalled();
    expect(res.message).not.toContain("hunter2");
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });

  test("handleAlertSendKeys staging branch redacts the staged credential", async () => {
    getPendingAlertKind.mockReturnValue(null);
    const res = await handleAlertSendKeys(DUMMY_CTX, {
      type: "alert_send_keys",
      text: "hunter2secret",
    });
    expect(res.success).toBe(true);
    expect(res.message).toContain("Staged text for next prompt:");
    expect(res.message).not.toContain("hunter2secret");
    expect(res.extractedContent ?? "").not.toContain("hunter2secret");
  });

  test("handleAlertAccept reports a typed failure when no dialog is open", async () => {
    getPendingAlertText.mockReturnValue(null);
    const res = await handleAlertAccept(DUMMY_CTX, { type: "alert_accept" });
    expect(res.success).toBe(false);
    expect(res.message).toContain("No JS dialog open");
  });
});

// ─── ask_human password redaction ────────────────────────────────────────────

describe("handleAskHuman password-mode redaction", () => {
  test("redacts the password value in both message and extractedContent", async () => {
    const res = await handleAskHuman(DUMMY_CTX, {
      type: "ask_human",
      question: "enter your password",
      mode: "password",
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toContain("[REDACTED password response (");
    expect(res.extractedContent).not.toContain("supersecretpw123");
    expect(res.message).not.toContain("supersecretpw123");
    expect(JSON.stringify(res)).not.toContain("supersecretpw123");
  });
});
