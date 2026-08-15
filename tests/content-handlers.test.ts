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
import { clampInt, isValidConsoleBridgeEntry } from "../src/extension/content-utils";
import { CONSOLE_CAPTURE_EVENT } from "../src/lib/agent/dom/console-capture";

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
      // Test adapter for the authoritative background pre-effect boundary.
      sendMessage: vi.fn().mockResolvedValue({ ok: true, effectCapability: "test-effect-capability" }),
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
  vi.doUnmock("@/lib/agent/tools/executor");
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

  test("EXTRACT_STATE serves the cached AX tree on an unchanged page (no regeneration)", async () => {
    let axCalls = 0;
    vi.doMock("@/lib/agent/dom/ax-tree", () => ({
      initElementMap: () => {},
      generateAccessibilityTree: () => {
        axCalls++;
        return { pageContent: "AX-TREE-FIXTURE" };
      },
    }));
    // Fixture DOM is set BEFORE the content script loads: the script's
    // MutationObserver (installed at init) then never records a mutation, so
    // the epoch stays stable across both sends and the second one is a cache
    // hit. Setting innerHTML after load would bump the epoch in a microtask
    // after the first send and turn the second send into a (correct) miss.
    document.body.innerHTML = "<button id='b'>Go</button>";
    await loadContentScript();
    const first = (await sendAsync({ type: "EXTRACT_STATE", tabs: [] }, EXT)) as {
      ok: boolean;
      state?: { axTree: string };
    };
    const second = (await sendAsync({ type: "EXTRACT_STATE", tabs: [] }, EXT)) as {
      ok: boolean;
      state?: { axTree: string };
    };
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The second EXTRACT_STATE is a cache hit (DOM/fingerprint/tabs/scroll
    // unchanged): the stashed tree is served without a second AX walk.
    expect(axCalls).toBe(1);
    expect(second.state!.axTree).toBe(first.state!.axTree);
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
          token: { runId: "run-async", dispatchRevision: 1 },
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

  test("no-policy cross-origin navigate is permitted (allow-all default)", async () => {
    await loadContentScript();
    const r = (await sendAsync(
      {
        type: "EXECUTE_ACTIONS",
        token: { runId: "run-no-policy", dispatchRevision: 1 },
        actions: [{ type: "navigate", url: "https://evil.example.com/" }],
      },
      EXT,
    )) as { ok: boolean; results: Array<{ success: boolean; message: string }> };
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
    // The content layer must NOT impose a same-origin gate when no domain
    // policy is configured: navigate/search keep the documented allow-all
    // default (security-url-policy.ts) and policy enforcement lives in the
    // handlers (navigate.ts) and the SW tab layer. Without this, a fresh
    // install can never leave the first page.
    expect(r.results[0].success).toBe(true);
    expect(r.results[0].message).not.toContain("BLOCKED");
  });

  test("skip-marker is appended after a policy-blocked action", async () => {
    await loadContentScript();
    const r = (await sendAsync(
      {
        type: "EXECUTE_ACTIONS",
        token: { runId: "run-skip", dispatchRevision: 1 },
        // A CONFIGURED policy (not the removed no-policy gate) blocks the
        // cross-origin navigate; the queue then skips the remaining actions.
        domainConfig: { blockedDomains: ["evil.example.com"] },
        actions: [
          { type: "navigate", url: "https://evil.example.com/" },
          { type: "click", index: 3 },
        ],
      },
      EXT,
    )) as { ok: boolean; results: Array<{ success: boolean; message: string }> };
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results[0].success).toBe(false);
    expect(r.results[0].message).toContain("BLOCKED");
    expect(r.results[1].success).toBe(false);
    expect(r.results[1].message).toContain("1 remaining action(s) skipped");
  });

  test("CANCEL_RUN rejects an already-delayed token before it can execute", async () => {
    await loadContentScript();
    const token = { runId: "run-a", dispatchRevision: 2 };
    expect(send({ type: "CANCEL_RUN", token }, EXT).response).toEqual({ ok: true });

    const r = send({ type: "EXECUTE_ACTIONS", token, actions: [] }, EXT);
    expect(r.response).toEqual({
      ok: false,
      error: "BLOCKED: dispatch cancelled or stale for run run-a",
    });
    expect(r.isAsync).toBe(false);
  });

  test("a cancellation cutoff does not block another run", async () => {
    await loadContentScript();
    expect(send({ type: "CANCEL_RUN", token: { runId: "run-a", dispatchRevision: 2 } }, EXT).response)
      .toEqual({ ok: true });

    const r = await sendAsync({
      type: "EXECUTE_ACTIONS",
      token: { runId: "run-b", dispatchRevision: 1 },
      actions: [],
    }, EXT) as { ok: boolean; results?: unknown[] };
    expect(r).toEqual({ ok: true, results: [] });
  });

  test("a delayed tokenless EXECUTE_ACTIONS cannot resurrect after cancellation or successor dispatch", async () => {
    await loadContentScript();
    expect(send({ type: "CANCEL_RUN", token: { runId: "run-old", dispatchRevision: 2 } }, EXT).response)
      .toEqual({ ok: true });

    const tokenless = send({ type: "EXECUTE_ACTIONS", actions: [{ type: "click", index: 1 }] }, EXT);
    expect(tokenless).toMatchObject({ isAsync: false, response: { ok: false, error: "invalid dispatch token" } });

    const successor = await sendAsync({
      type: "EXECUTE_ACTIONS",
      token: { runId: "run-successor", dispatchRevision: 1 },
      actions: [],
    }, EXT);
    expect(successor).toEqual({ ok: true, results: [] });
  });

  test("CANCEL_RUN aborts active matching work and never starts the remaining batch", async () => {
    let actionStarted!: () => void;
    const firstActionStarted = new Promise<void>((resolve) => { actionStarted = resolve; });
    const executeAction = vi.fn((_action: unknown, _state: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        actionStarted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );
    vi.doMock("@/lib/agent/tools/executor", () => ({ executeAction }));
    await loadContentScript();

    const dispatchToken = { runId: "run-a", dispatchRevision: 1 };
    const execution = sendAsync({
      type: "EXECUTE_ACTIONS",
      token: dispatchToken,
      actions: [{ type: "click", index: 0 }, { type: "click", index: 1 }],
    }, EXT);
    await firstActionStarted;

    expect(send({ type: "CANCEL_RUN", token: { runId: "run-a", dispatchRevision: 2 } }, EXT).response)
      .toEqual({ ok: true });
    const r = await execution as {
      ok: boolean;
      results: Array<{ success: boolean; message: string }>;
    };

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(executeAction.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(r.results.every((result) => !result.success && /cancelled or stale/.test(result.message))).toBe(true);
  });

  /**
   * These were intentional expected failures (spoofing residual): the
   * page shares the CustomEvent namespace with the MAIN-world capture, so a
   * forged entry used to reach the SW ring. The console-bridge admission gate
   * (`isValidConsoleBridgeEntry` in content-utils.ts) now rejects malformed
   * and oversized entries at the isolated-world boundary before forwarding —
   * both cases are now ordinary passing tests.
   */
  test("ignores a page-forged malformed console bridge entry", async () => {
    await loadContentScript();
    window.dispatchEvent(new CustomEvent(CONSOLE_CAPTURE_EVENT, {
      detail: { entry: { type: "not-a-console-level", message: 17, timestamp: "never" } },
    }));
    await Promise.resolve();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test("rejects an oversized page-forged console bridge entry", async () => {
    await loadContentScript();
    window.dispatchEvent(new CustomEvent(CONSOLE_CAPTURE_EVENT, {
      detail: {
        entry: {
          type: "warning",
          message: "x".repeat(2_001),
          timestamp: Date.now(),
        },
      },
    }));
    await Promise.resolve();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  test("forwards a well-formed console bridge entry to the SW ring", async () => {
    await loadContentScript();
    // Each loadContentScript re-imports content.ts, which registers one more
    // listener on the shared window event — every accumulated listener hears
    // the dispatch and forwards through the SAME admission gate. Assert every
    // forwarded call carries exactly the validated entry (a forged shape would
    // be rejected by every listener, so a mismatch anywhere fails the test).
    const mock = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    const entry = { type: "log" as const, message: "hello from the page", timestamp: 1234 };
    window.dispatchEvent(new CustomEvent(CONSOLE_CAPTURE_EVENT, { detail: { entry } }));
    await Promise.resolve();

    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of mock.mock.calls) {
      expect(call[0]).toEqual({ type: "CONSOLE_LOG_ENTRY", entry });
    }
  });
});

describe("isValidConsoleBridgeEntry admission", () => {
  const valid = { type: "log" as const, message: "ok", timestamp: 1 };

  test("admits a well-formed entry", () => {
    expect(isValidConsoleBridgeEntry(valid)).toBe(true);
  });

  test("rejects non-objects, arrays, and missing payloads", () => {
    expect(isValidConsoleBridgeEntry(null)).toBe(false);
    expect(isValidConsoleBridgeEntry(undefined)).toBe(false);
    expect(isValidConsoleBridgeEntry("log")).toBe(false);
    expect(isValidConsoleBridgeEntry([valid])).toBe(false);
    expect(isValidConsoleBridgeEntry({})).toBe(false);
  });

  test("rejects unknown console levels and non-string messages", () => {
    expect(isValidConsoleBridgeEntry({ ...valid, type: "debug" })).toBe(false);
    expect(isValidConsoleBridgeEntry({ ...valid, type: 42 })).toBe(false);
    expect(isValidConsoleBridgeEntry({ ...valid, message: 17 })).toBe(false);
    expect(isValidConsoleBridgeEntry({ ...valid, message: undefined })).toBe(false);
  });

  test("rejects non-finite timestamps", () => {
    expect(isValidConsoleBridgeEntry({ ...valid, timestamp: "never" })).toBe(false);
    expect(isValidConsoleBridgeEntry({ ...valid, timestamp: Number.NaN })).toBe(false);
    expect(isValidConsoleBridgeEntry({ ...valid, timestamp: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test("enforces the capture byte bound code-point-aware", () => {
    expect(isValidConsoleBridgeEntry({ ...valid, message: "x".repeat(2_000) })).toBe(true);
    expect(isValidConsoleBridgeEntry({ ...valid, message: "x".repeat(2_001) })).toBe(false);
    // A surrogate pair (2 UTF-16 units, 1 code point) inside the cap must pass.
    expect(isValidConsoleBridgeEntry({ ...valid, message: "😀".repeat(1_000) })).toBe(true);
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
