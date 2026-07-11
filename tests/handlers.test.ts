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
import { makeState, installLocalStorageStub } from "./helpers";

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

// Fresh DOM + clean spies + no accidental chrome global each test.
installLocalStorageStub();

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(secrets, "substituteSecrets");
  vi.spyOn(window, "open").mockImplementation(() => null);
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
  delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
  delete (globalThis as Record<string, unknown>).__openCoworkDomainConfig;
});

/** Build an ActionContext whose `state.selectorMap[index]` is `el`. */
function ctxFor(el: HTMLElement, index: number): ActionContext {
  return {
    state: makeState({ selectorMap: { [index]: el } }),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  } as ActionContext;
}

/** Build an ActionContext with an EMPTY selectorMap (no element at any index). */
function ctxEmpty(): ActionContext {
  return {
    state: makeState({ selectorMap: {} }),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  } as ActionContext;
}

// ─── click ───────────────────────────────────────────────────────────────────

describe("handleClick", () => {
  test("native el.click() fires on the resolved element (real side effect)", async () => {
    const btn = document.createElement("button");
    let clicked = false;
    btn.addEventListener("click", () => { clicked = true; });
    document.body.appendChild(btn);
    const res = await handleClick(ctxFor(btn, 1), { type: "click", index: 1 } as never);
    expect(res.success).toBe(true);
    expect(clicked).toBe(true);
    expect(res.message).toContain("Clicked [1]");
  });

  test("uses the CDP coordinate path when an extension runtime is present", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "ext-id", sendMessage },
    };
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const res = await handleClick(ctxFor(btn, 1), { type: "click", index: 1 } as never);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "CDP_CLICK" }),
    );
    expect(res.success).toBe(true);
    expect(res.message).toContain("(CDP)");
  });

  test("missing selector throws a typed 'not found' error (not a crash)", async () => {
    const res = handleClick(ctxEmpty(), { type: "click", index: 99 } as never);
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
      { type: "input", index: 1, text: "hello world" } as never,
    );
    expect(res.success).toBe(true);
    expect(input.value).toBe("hello world");
    expect(res.message).toContain("hello world");
  });

  test("substituteSecrets is invoked and the REAL secret is redacted from the LLM-facing message", async () => {
    await setSecret("email", "real-secret-value@x.com");
    const input = document.createElement("input");
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "%email%" } as never,
    );
    // The placeholder WAS substituted into the DOM (the field is filled).
    expect(input.value).toBe("real-secret-value@x.com");
    // substituteSecrets must have been called with the original placeholder.
    expect(secrets.substituteSecrets).toHaveBeenCalledWith("%email%");
    // The real secret value must NOT leak into the result message that the
    // loop replays into every subsequent LLM prompt / run-history.
    expect(res.message).not.toContain("real-secret-value@x.com");
    expect(res.message).toContain("REDACTED");
  });

  test("with no stored secret the placeholder is kept (never becomes a leaked real value)", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "%no_such_secret%" } as never,
    );
    expect(input.value).toBe("%no_such_secret%");
    expect(res.message).toContain("%no_such_secret%");
  });

  test("clears the field when clear:false is not set / appends when clear:false", async () => {
    const input = document.createElement("input");
    input.value = "pre";
    document.body.appendChild(input);
    const res = await handleInput(
      ctxFor(input, 1),
      { type: "input", index: 1, text: "fix", clear: false } as never,
    );
    expect(res.success).toBe(true);
    expect(input.value).toBe("prefix");
  });

  test("missing selector throws a typed 'not found' error", async () => {
    await expect(
      handleInput(ctxEmpty(), { type: "input", index: 7, text: "x" } as never),
    ).rejects.toThrow(/not found/);
  });

  test("throws on a non-text element (input/textarea/contenteditable required)", async () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    await expect(
      handleInput(ctxFor(div, 1), { type: "input", index: 1, text: "x" } as never),
    ).rejects.toThrow(/not a text input/);
  });
});

// ─── navigate ────────────────────────────────────────────────────────────────

describe("handleNavigate", () => {
  test("new-tab navigation with no extension context delegates to window.open", async () => {
    const res = await handleNavigate({} as ActionContext, {
      type: "navigate",
      url: "https://example.com/x",
      new_tab: true,
    } as never);
    expect(window.open).toHaveBeenCalledWith("https://example.com/x", "_blank");
    expect(res.success).toBe(true);
    expect(res.message).toContain("navigated");
  });

  test("new-tab navigation sends a TAB_ACTION message when an extension runtime is present", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, success: true, pageChanged: true }));
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { id: "ext-id", sendMessage },
    };
    const res = await handleNavigate({} as ActionContext, {
      type: "navigate",
      url: "https://example.com/x",
      new_tab: true,
    } as never);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TAB_ACTION" }),
    );
    expect(res.success).toBe(true);
  });

  test("blocked by the domain allowlist — returns a typed BLOCKED failure", async () => {
    (globalThis as Record<string, unknown>).__openCoworkDomainConfig = {
      allowedDomains: ["example.com"],
    };
    const res = await handleNavigate({} as ActionContext, {
      type: "navigate",
      url: "https://evil.example.org/x",
      new_tab: false,
    } as never);
    expect(res.success).toBe(false);
    expect(res.message).toContain("BLOCKED");
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
      { type: "upload_file", index: 1, path: "/tmp/x" } as never,
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain("not supported in autonomous mode");
  });

  test("throws a typed error when the element is not a file input", async () => {
    const text = document.createElement("input");
    document.body.appendChild(text);
    await expect(
      handleUploadFile(ctxFor(text, 1), { type: "upload_file", index: 1, path: "/tmp/x" } as never),
    ).rejects.toThrow(/is not a file input/);
  });

  test("missing selector throws a typed 'not found' error", async () => {
    await expect(
      handleUploadFile(ctxEmpty(), {
        type: "upload_file",
        index: 42,
        path: "/tmp/x",
      } as never),
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
    const res = await handleSendKeys({} as ActionContext, {
      type: "send_keys",
      keys: "a",
    } as never);
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
    await handleSendKeys({} as ActionContext, { type: "send_keys", keys: "Enter" } as never);
    expect(requestSubmit).toHaveBeenCalled();
  });
});

// ─── scroll ──────────────────────────────────────────────────────────────────

describe("handleScroll", () => {
  test("scrolls down by N pages (positive delta)", async () => {
    const res = await handleScroll({} as ActionContext, {
      type: "scroll",
      down: true,
      pages: 2,
    } as never);
    expect(window.scrollBy).toHaveBeenCalledWith(
      expect.objectContaining({ top: expect.any(Number) }),
    );
    const top = (window.scrollBy as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].top;
    expect(top).toBeGreaterThan(0);
    expect(res.message).toContain("Scrolled down 2");
  });

  test("scrolls up (negative delta)", async () => {
    await handleScroll({} as ActionContext, { type: "scroll", down: false, pages: 1 } as never);
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
    const res = await handleHover(ctxFor(el, 1), { type: "hover", index: 1 } as never);
    expect(seen).toEqual(expect.arrayContaining(["mouseenter", "mouseover", "mousemove"]));
    expect(res.success).toBe(true);
    expect(res.message).toContain("Hovered [1]");
  });

  test("missing selector throws a typed 'not found' error", async () => {
    await expect(
      handleHover(ctxEmpty(), { type: "hover", index: 5 } as never),
    ).rejects.toThrow(/not found/);
  });
});
