/**
 * Tool-handler execution logic coverage.
 *
 * Only `find-elements` + `evaluate` were directly tested before. These handlers
 * perform privileged, side-effecting actions (clicking, typing, navigating,
 * dispatching keys, scrolling, hovering) — `input.ts` in particular calls
 * `substituteSecrets` and must never leak a real secret back into the
 * LLM-facing result.
 *
 * This file drives REAL side effects against jsdom elements + a minimal mocked
 * `chrome` global, and asserts error shapes (typed throws, not crashes) on bad
 * input. Harness modeled on `tests/executor-actions.test.ts` /
 * `tests/evaluate.test.ts`.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { makeState, installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

// Visual/feedback helpers that schedule timers or need real layout — stub them
// so the tests assert only on the click/input/hover *side effects*.
vi.mock("../src/lib/agent/dom/overlay", () => ({
  highlightElement: vi.fn(() => ({ remove: () => {} })),
}));
vi.mock("../src/lib/agent/dom/phantom-cursor", () => ({
  moveCursorToElement: vi.fn(async () => {}),
}));

import * as secrets from "../src/lib/agent/secrets";
import { setSecret } from "../src/lib/agent/secrets";
import { handleClick } from "../src/lib/agent/tools/handlers/click";
import { handleInput } from "../src/lib/agent/tools/handlers/input";
import { handleNavigate } from "../src/lib/agent/tools/handlers/navigate";
import { handleUploadFile } from "../src/lib/agent/tools/handlers/upload-file";
import { handleSendKeys } from "../src/lib/agent/tools/handlers/send-keys";
import { handleScroll } from "../src/lib/agent/tools/handlers/scroll";
import { handleHover } from "../src/lib/agent/tools/handlers/hover";

/** Install the extension-runtime mock (`chrome.runtime.id` + `sendMessage`). */
function installExtensionMock(sendMessage: () => Promise<unknown>): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { id: "ext-id", sendMessage },
  };
}

// Fresh DOM + clean spies + no accidental chrome global each test.
// The localStorage stub is installed per-test (not at module scope) so a
// secret written by one test (e.g. the input-secret test) never leaks into
// the next test's store.
beforeEach(() => {
  installLocalStorageStub();
  document.body.innerHTML = "";
  vi.spyOn(secrets, "substituteSecrets");
  vi.spyOn(window, "open").mockImplementation(() => null);
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
  delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
  restoreLocalStorageStub();
});

/** Build an ActionContext whose `state.selectorMap[index]` is `el`. */
function ctxFor(el: HTMLElement, index: number): ActionContext {
  return {
    state: makeState({ selectorMap: { [index]: el } }),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  };
}

/** Build an ActionContext with an EMPTY selectorMap (no element at any index). */
function ctxEmpty(): ActionContext {
  return {
    state: makeState({ selectorMap: {} }),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  };
}

/** Build an ActionContext for handlers that ignore the context entirely. */
function emptyCtx(): ActionContext {
  return {
    state: makeState(),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  };
}

// ─── click ───────────────────────────────────────────────────────────────────

describe("handleClick", () => {
  test("native el.click() fires on the resolved element (real side effect)", async () => {
    const btn = document.createElement("button");
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    document.body.appendChild(btn);
    const res = await handleClick(ctxFor(btn, 1), { type: "click", index: 1 });
    expect(res.success).toBe(true);
    expect(clicked).toBe(true);
    expect(res.message).toContain("Clicked [1]");
  });

  test("uses the CDP coordinate path when an extension runtime is present", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    installExtensionMock(sendMessage);
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const res = await handleClick(ctxFor(btn, 1), { type: "click", index: 1 });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CDP_CLICK" }),
    );
    expect(res.success).toBe(true);
    expect(res.message).toContain("(CDP)");
  });

  test("missing selector throws a typed 'not found' error (not a crash)", async () => {
    const res = handleClick(ctxEmpty(), { type: "click", index: 99 });
    await expect(res).rejects.toThrow(/not found/);
  });
});

// ─── input ───────────────────────────────────────────────────────────────────

describe("handleInput", () => {
  test("types plain text into the element's value (real side effect)", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "hello world" },
    );
    expect(res.success).toBe(true);
    expect(input.value).toBe("hello world");
    expect(res.message).toContain("hello world");
  });

  test("STOP during secret lookup prevents every typing mutation", async () => {
    let release!: (value: string) => void;
    vi.mocked(secrets.substituteSecrets).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const input = document.createElement("input");
    input.value = "original";
    document.body.appendChild(input);
    const controller = new AbortController();
    const pending = handleInput(
      { ...ctxFor(input, 1), signal: controller.signal },
      { type: "input", index: 1, text: "%email%" },
    );
    await vi.waitFor(() => expect(secrets.substituteSecrets).toHaveBeenCalledWith("%email%"));

    controller.abort(new DOMException("Stopped", "AbortError"));
    release("should-never-be-typed");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(input.value).toBe("original");
  });

  test("substituteSecrets is invoked and the REAL secret never leaks into the DOM or the LLM-facing message", async () => {
    await setSecret("email", "real-secret-value@x.com");
    const input = document.createElement("input");
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "%email%" },
    );
    // substituteSecrets must have been invoked on the placeholder.
    expect(secrets.substituteSecrets).toHaveBeenCalledWith("%email%");
    // Without a trusted substitution context the placeholder is preserved, so the
    // real secret MUST NOT appear in the filled field or in the result message
    // that the loop replays into every subsequent LLM prompt / run-history.
    expect(input.value).toBe("%email%");
    expect(input.value).not.toContain("real-secret-value@x.com");
    expect(res.message).not.toContain("real-secret-value@x.com");
    expect(JSON.stringify(res)).not.toContain("real-secret-value@x.com");
    expect(res.message).toContain("%email%");
  });

  test("with no stored secret the placeholder is kept (never becomes a leaked real value)", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "%no_such_secret%" },
    );
    expect(input.value).toBe("%no_such_secret%");
    expect(res.message).toContain("%no_such_secret%");
  });

  test("appends text to an existing value when clear:false", async () => {
    const input = document.createElement("input");
    input.value = "pre";
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "fix", clear: false },
    );
    expect(res.success).toBe(true);
    expect(input.value).toBe("prefix");
  });

  test("missing selector throws a typed 'not found' error", async () => {
    await expect(
      handleInput(ctxEmpty(), { type: "input", index: 7, text: "x" }),
    ).rejects.toThrow(/not found/);
  });

  test("throws on a non-text element (input/textarea/contenteditable required)", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    await expect(
      handleInput(ctxFor(div, 1), { type: "input", index: 1, text: "x" }),
    ).rejects.toThrow(/not a text input/);
  });
});

describe("handleScroll cancellation", () => {
  test("STOP aborts a pending vision-cache RPC instead of retrying or reporting success", async () => {
    const sendMessage = vi.fn(() => new Promise(() => {}));
    installExtensionMock(sendMessage);
    const controller = new AbortController();
    const pending = handleScroll(
      { ...emptyCtx(), signal: controller.signal },
      { type: "scroll", down: true, pages: 1 },
    );
    window.dispatchEvent(new Event("scrollend"));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

// ─── navigate ────────────────────────────────────────────────────────────────

describe("handleNavigate", () => {
  test("new-tab navigation with no extension context delegates to window.open", async () => {
    // Simulate a popup that is NOT blocked (window.open returns a window).
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "https://example.com/x",
      new_tab: true,
    });
    expect(openSpy).toHaveBeenCalledWith("https://example.com/x", "_blank");
    expect(res.success).toBe(true);
    expect(res.message).toContain("navigated");
    openSpy.mockRestore();
  });

  test("new-tab navigation sends a TAB_ACTION message when an extension runtime is present", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, success: true, pageChanged: true }));
    installExtensionMock(sendMessage);
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "https://example.com/x",
      new_tab: true,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TAB_ACTION" }),
    );
    expect(res.success).toBe(true);
  });

  test("blocked by the domain allowlist — returns a typed BLOCKED failure", async () => {
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      allowedDomains: ["example.com"],
    };
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "https://evil.example.org/x",
      new_tab: false,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    // The block must be actionable: name the remedy (and the escape hatch) so
    // the model can surface it to the user instead of retrying blindly.
    expect(res.message).toContain("allowedDomains");
    expect(res.message).toContain("ask_human");
  });

  test("blocked by the domain allowlist even via the extension runtime (CDP/TAB_ACTION path)", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, success: true, pageChanged: true }));
    installExtensionMock(sendMessage);
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      allowedDomains: ["example.com"],
    };
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "https://evil.example.org/x",
      new_tab: true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    // The allowlist guard must run BEFORE the extension branch.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("blocks a javascript: scheme (XSS) without an extension runtime (new-tab)", async () => {
    const openSpy = vi.spyOn(window, "open");
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "javascript:alert(document.cookie)",
      new_tab: true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  test("blocks a data: scheme without an extension runtime (new-tab)", async () => {
    const openSpy = vi.spyOn(window, "open");
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "data:text/html,<script>alert(1)</script>",
      new_tab: true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  test("blocks a javascript: scheme via the extension runtime (new-tab)", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, success: true, pageChanged: true }));
    installExtensionMock(sendMessage);
    const res = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "javascript:alert(document.cookie)",
      new_tab: true,
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("blocks a data: scheme on both new-tab and same-tab paths", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, success: true, pageChanged: true }));
    installExtensionMock(sendMessage);
    const newTab = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "data:text/html,<script>alert(1)</script>",
      new_tab: true,
    });
    expect(newTab.success).toBe(false);
    expect(newTab.message).toContain("BLOCKED");
    const sameTab = await handleNavigate(emptyCtx(), {
      type: "navigate",
      url: "data:text/html,<script>alert(1)</script>",
      new_tab: false,
    });
    expect(sameTab.success).toBe(false);
    expect(sameTab.message).toContain("BLOCKED");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// ─── upload-file ─────────────────────────────────────────────────────────────

describe("handleUploadFile", () => {
  test("returns an honest failure (no crash) for a real file input", async () => {
    const file = document.createElement("input");
    file.type = "file";
    document.body.appendChild(file);
    const res = await handleUploadFile(
      ctxFor(file, 1),
      { type: "upload_file", index: 1, path: "/tmp/x" },
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported in autonomous mode");
  });

  test("throws a typed error when the element is not a file input", async () => {
    const text = document.createElement("input");
    document.body.appendChild(text);
    await expect(
      handleUploadFile(ctxFor(text, 1), { type: "upload_file", index: 1, path: "/tmp/x" }),
    ).rejects.toThrow(/is not a file input/);
  });

  test("missing selector throws a typed 'not found' error", async () => {
    await expect(
      handleUploadFile(ctxEmpty(), {
        type: "upload_file",
        index: 42,
        path: "/tmp/x",
      }),
    ).rejects.toThrow(/not found/);
  });
});

// ─── send-keys ───────────────────────────────────────────────────────────────

describe("handleSendKeys", () => {
  test("dispatches keydown/keyup on the active element (real side effect)", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    let keydown = false;
    input.addEventListener("keydown", () => { keydown = true; });
    const res = await handleSendKeys(emptyCtx(), {
      type: "send_keys",
      keys: "a",
    });
    expect(keydown).toBe(true);
    expect(res.success).toBe(true);
    expect(res.message).toContain("Sent keys");
  });

  test("Enter submits the enclosing form via requestSubmit", async () => {
    const form = document.createElement("form");
    const input = document.createElement("input");
    form.appendChild(input);
    document.body.appendChild(form);
    const requestSubmit = vi.fn();
    (form as unknown as { requestSubmit: () => void }).requestSubmit = requestSubmit;
    input.focus();
    await handleSendKeys(emptyCtx(), { type: "send_keys", keys: "Enter" });
    expect(requestSubmit).toHaveBeenCalled();
  });
});

// ─── scroll ──────────────────────────────────────────────────────────────────

describe("handleScroll", () => {
  test("scrolls down by N pages (positive delta)", async () => {
    const res = await handleScroll(emptyCtx(), {
      type: "scroll",
      down: true,
      pages: 2,
    });
    expect(window.scrollBy).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number) }),
    );
    const top = (window.scrollBy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].top;
    expect(top).toBeGreaterThan(0);
    expect(res.message).toContain("Scrolled down 2");
  });

  test("scrolls up (negative delta)", async () => {
    await handleScroll(emptyCtx(), { type: "scroll", down: false, pages: 1 });
    const top = (window.scrollBy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].top;
    expect(top).toBeLessThan(0);
  });
});

// ─── hover ───────────────────────────────────────────────────────────────────

describe("handleHover", () => {
  test("dispatches mouseenter/mouseover/mousemove on the element (real side effects)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const seen: string[] = [];
    el.addEventListener("mouseenter", () => seen.push("mouseenter"));
    el.addEventListener("mouseover", () => seen.push("mouseover"));
    el.addEventListener("mousemove", () => seen.push("mousemove"));
    const res = await handleHover(ctxFor(el, 1), { type: "hover", index: 1 });
    expect(seen).toEqual(expect.arrayContaining(["mouseenter", "mouseover", "mousemove"]));
    expect(res.success).toBe(true);
    expect(res.message).toContain("Hovered [1]");
  });

  test("missing selector throws a typed 'not found' error", async () => {
    await expect(
      handleHover(ctxEmpty(), { type: "hover", index: 5 }),
    ).rejects.toThrow(/not found/);
  });
});
