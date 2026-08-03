/**
 * Content-script message surface tests — pins the `chrome.runtime.onMessage`
 * wiring in `content.ts` and the handler behavior in `content-utils.ts`:
 * sender-identity check, `clampInt` bounds, the no-policy same-origin
 * navigation guard, the skip-marker logic, error-path responses, EXTRACT_HTML
 * redaction and cap, and the async EXECUTE_ACTIONS response window.
 *
 * The content script is an IIFE that registers its listener at module import,
 * so every test loads a fresh module graph (vi.resetModules) against a fresh
 * chrome mock and captures the registered listener.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { clampInt } from "../src/extension/content-utils";

type ListenerFn = (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => boolean | undefined;

let listener: ListenerFn | undefined;

function installChromeMock(): void {
  listener = undefined;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: {
        addListener: (fn: ListenerFn) => {
          listener = fn;
        },
      },
    },
  };
}

/** Register the real content script (fresh module graph + mock per call). */
async function loadContentScript(): Promise<void> {
  vi.resetModules();
  installChromeMock();
  await import("../src/extension/content");
  expect(listener).toBeDefined();
}

/** Synchronous message send; captures the response + async-return flag. */
function send(msg: unknown, sender: unknown): {
  response: unknown;
  responded: boolean;
  isAsync: boolean;
} {
  let response: unknown;
  let responded = false;
  const sendResponse = (r: unknown) => {
    response = r;
    responded = true;
  };
  const isAsync = listener!(msg, sender, sendResponse);
  return { response, responded, isAsync: isAsync === true };
}

/** Message send for async handlers (EXECUTE_ACTIONS, EXTRACT_STATE, …). */
function sendAsync(msg: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    listener!(msg, sender, (r) => resolve(r));
  });
}

const EXT = { id: "test-extension-id" };

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__openCoworkInjected;
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.doUnmock("@/lib/agent/dom/ax-tree");
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("content.ts message surface", () => {
  test("unauthorized sender is rejected before dispatch", async () => {
    await loadContentScript();
    const r = send({ type: "PING" }, { id: "some-other-extension" });
    expect(r.response).toEqual({ ok: false, error: "unauthorized sender" });
    expect(r.isAsync).toBe(false);
  });

  test("PING responds ok synchronously", async () => {
    await loadContentScript();
    const r = send({ type: "PING" }, EXT);
    expect(r.response).toEqual({ ok: true });
    expect(r.isAsync).toBe(false);
  });

  test("unknown message type is ignored (no response, not async)", async () => {
    await loadContentScript();
    const r = send({ type: "BOGUS" }, EXT);
    expect(r.isAsync).toBe(false);
    expect(r.responded).toBe(false);
  });

  test("EXTRACT_HTML returns outerHTML with key shapes redacted", async () => {
    await loadContentScript();
    document.body.innerHTML =
      '<textarea>sk-abcdefghijklmnopqrstuvwxyz1234567890</textarea>';
    const r = (await sendAsync({ type: "EXTRACT_HTML" }, EXT)) as {
      ok: boolean;
      html?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.html).toContain("textarea");
    expect(r.html).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
  });

  test("EXTRACT_HTML caps the response at 500k", async () => {
    await loadContentScript();
    document.body.innerHTML = `<textarea>${"x".repeat(600_000)}</textarea>`;
    const r = (await sendAsync({ type: "EXTRACT_HTML" }, EXT)) as {
      ok: boolean;
      html?: string;
    };
    expect(r.ok).toBe(true);
    expect(r.html!.length).toBeLessThanOrEqual(500_000);
  });

  test("EXTRACT_STATE returns serializable state with axTree and fingerprint", async () => {
    await loadContentScript();
    document.body.innerHTML = "<button id='b'>Go</button>";
    const r = (await sendAsync({ type: "EXTRACT_STATE", tabs: [] }, EXT)) as {
      ok: boolean;
      state?: {
        axTree: string;
        fingerprint: string;
        elementRects: unknown[];
        elements: unknown[];
      };
    };
    expect(r.ok).toBe(true);
    expect(typeof r.state!.axTree).toBe("string");
    expect(typeof r.state!.fingerprint).toBe("string");
    expect(Array.isArray(r.state!.elementRects)).toBe(true);
    expect(r.state!.elementRects).toHaveLength(r.state!.elements.length);
  });

  test("EXTRACT_STATE surfaces an error response when AX tree generation throws", async () => {
    vi.doMock("@/lib/agent/dom/ax-tree", () => ({
      initElementMap: () => {},
      generateAccessibilityTree: () => {
        throw new Error("ax boom");
      },
    }));
    await loadContentScript();
    const r = (await sendAsync({ type: "EXTRACT_STATE", tabs: [] }, EXT)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ax boom");
  });

  test("EXTRACT_HTML surfaces an error response when documentElement is unavailable", async () => {
    await loadContentScript();
    const orig = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      value: { documentElement: null },
      configurable: true,
    });
    try {
      const r = (await sendAsync({ type: "EXTRACT_HTML" }, EXT)) as {
        ok: boolean;
        error?: string;
      };
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe("string");
    } finally {
      Object.defineProperty(globalThis, "document", {
        value: orig,
        configurable: true,
      });
    }
  });

  test("GET_DOM_FINGERPRINT returns a fingerprint", async () => {
    await loadContentScript();
    document.body.innerHTML = "<div data-x='1'>a</div>";
    const r = (await sendAsync({ type: "GET_DOM_FINGERPRINT" }, EXT)) as {
      ok: boolean;
      fingerprint?: string;
    };
    expect(r.ok).toBe(true);
    expect(typeof r.fingerprint).toBe("string");
    expect(r.fingerprint!.length).toBeGreaterThan(0);
  });

  test("EXECUTE_ACTIONS returns true (async response window contract)", async () => {
    await loadContentScript();
    const r = await new Promise<{ ok: boolean }>((resolve) => {
      const isAsync = listener!(
        {
          type: "EXECUTE_ACTIONS",
          actions: [{ type: "navigate", url: "https://evil.example.com/" }],
        },
        EXT,
        (res) => resolve(res as { ok: boolean }),
      );
      // The handler signals an open response channel; the SW keeps the port
      // alive until this returns.
      expect(isAsync).toBe(true);
    });
    expect(r.ok).toBe(true);
  });

  test("no-policy same-origin navigation guard blocks cross-origin navigate", async () => {
    await loadContentScript();
    const r = (await sendAsync(
      {
        type: "EXECUTE_ACTIONS",
        actions: [{ type: "navigate", url: "https://evil.example.com/" }],
      },
      EXT,
    )) as { ok: boolean; results: Array<{ success: boolean; message: string }> };
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].success).toBe(false);
    expect(r.results[0].message).toContain(
      "BLOCKED: no domain policy enforced — only same-origin navigation is permitted",
    );
  });

  test("skip-marker is appended after a blocked action", async () => {
    await loadContentScript();
    const r = (await sendAsync(
      {
        type: "EXECUTE_ACTIONS",
        actions: [
          { type: "navigate", url: "https://evil.example.com/" },
          { type: "click", index: 3 },
        ],
      },
      EXT,
    )) as { ok: boolean; results: Array<{ success: boolean; message: string }> };
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results[1].success).toBe(false);
    expect(r.results[1].message).toContain("1 remaining action(s) skipped");
  });
});

describe("clampInt bounds", () => {
  test("clamps values above max and below min", () => {
    expect(clampInt(999, 15, 1, 50)).toBe(50);
    expect(clampInt(0, 15, 1, 50)).toBe(1);
  });

  test("floors fractional values", () => {
    expect(clampInt(12.9, 15, 1, 50)).toBe(12);
  });

  test("falls back for undefined and non-finite values", () => {
    expect(clampInt(undefined, 15, 1, 50)).toBe(15);
    expect(clampInt(Number.NaN, 15, 1, 50)).toBe(15);
    expect(clampInt(Number.POSITIVE_INFINITY, 15, 1, 50)).toBe(15);
  });
});
