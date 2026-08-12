/**
 * Wait-condition family — wait_for_element / wait_for_text /
 * wait_for_url / wait_for_network_idle semantics.
 *
 * Pinned contracts:
 * - timeout is in seconds, converted to ms; missing element + short timeout
 *   HARD-FAILS the action (success:false) — never a silent success.
 * - element states: visible = attached + not hidden/zero-size; hidden =
 *   not visible; attached = in DOM; detached = not in DOM.
 * - wait_for_text is a body.innerText SUBSTRING match.
 * - wait_for_url uses glob semantics: `*` does NOT match `/`, `**` matches
 *   everything.
 * - polling interval is min(0.1s, remaining); each poll re-runs the
 *   condition against the LIVE DOM (no snapshot).
 * - an abort signal mid-wait rejects the pending poll promptly.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { makeState, installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers";
import {
  handleWaitForElement,
  handleWaitForText,
  handleWaitForUrl,
  handleWaitForNetworkIdle,
  globToRegExp,
} from "../src/lib/agent/tools/handlers/wait";

function ctx(signal?: AbortSignal): ActionContext {
  return {
    state: makeState(),
    beforeUrl: location.href,
    beforeFingerprint: "fp",
    signal,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  installJsdomLayoutMock();
});

afterEach(() => {
  restoreJsdomLayoutMock();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Timeout hard-fail + seconds→ms conversion ─────────────────────────────

describe("wait_for_element: timeout semantics", () => {
  test("missing element with a 1s timeout HARD-FAILS (success:false)", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#never-there",
      state: "visible",
      timeout_seconds: 1,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timed out/i);
    expect(result.message).toContain("#never-there");
  });

  test("timeout_seconds is converted seconds→ms (0.2s fails fast, not 20s)", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#never-there",
      state: "visible",
      timeout_seconds: 0.2,
    });
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/0\.2/);
  });

  test("default timeout is 30s when omitted", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#never-there",
      state: "visible",
    });
    await vi.advanceTimersByTimeAsync(29_000);
    expect((await Promise.race([promise, Promise.resolve("pending")]))).toBe("pending");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/30/);
  });
});

// ─── Element states ────────────────────────────────────────────────────────

describe("wait_for_element: states", () => {
  test("visible succeeds immediately for an attached, sized element", async () => {
    const el = document.createElement("div");
    el.id = "on-page";
    el.textContent = "hi";
    document.body.appendChild(el);
    const result = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#on-page",
      state: "visible",
      timeout_seconds: 1,
    });
    expect(result.success).toBe(true);
  });

  test("visible fails for a display:none element; hidden succeeds", async () => {
    const el = document.createElement("div");
    el.id = "hidden-el";
    el.style.display = "none";
    document.body.appendChild(el);
    const visible = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#hidden-el",
      state: "visible",
      timeout_seconds: 0.1,
    });
    expect(visible.success).toBe(false);
    const hidden = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#hidden-el",
      state: "hidden",
      timeout_seconds: 0.5,
    });
    expect(hidden.success).toBe(true);
  });

  test("visibility:hidden counts as hidden", async () => {
    const el = document.createElement("div");
    el.id = "vhidden";
    el.style.visibility = "hidden";
    document.body.appendChild(el);
    const result = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#vhidden",
      state: "hidden",
      timeout_seconds: 0.5,
    });
    expect(result.success).toBe(true);
  });

  test("attached succeeds for a display:none element (still in DOM); detached fails", async () => {
    const el = document.createElement("div");
    el.id = "attached-el";
    el.style.display = "none";
    document.body.appendChild(el);
    const attached = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#attached-el",
      state: "attached",
      timeout_seconds: 0.5,
    });
    expect(attached.success).toBe(true);
    const detached = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#attached-el",
      state: "detached",
      timeout_seconds: 0.1,
    });
    expect(detached.success).toBe(false);
  });

  test("detached succeeds when the element does not exist; attached fails", async () => {
    const detached = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#missing",
      state: "detached",
      timeout_seconds: 0.5,
    });
    expect(detached.success).toBe(true);
    const attached = await handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#missing",
      state: "attached",
      timeout_seconds: 0.1,
    });
    expect(attached.success).toBe(false);
  });

  test("element appearing after the first poll is detected (fresh eval per poll)", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForElement(ctx(), {
      type: "wait_for_element",
      selector: "#late",
      state: "visible",
      timeout_seconds: 5,
    });
    vi.advanceTimersByTime(150); // first poll(s) with no element
    const el = document.createElement("div");
    el.id = "late";
    document.body.appendChild(el);
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result.success).toBe(true);
  });
});

// ─── wait_for_text ─────────────────────────────────────────────────────────

describe("wait_for_text: substring match", () => {
  test("substring found in body.innerText succeeds", async () => {
    document.body.textContent = "Hello, the order number is 4821. Goodbye";
    const result = await handleWaitForText(ctx(), {
      type: "wait_for_text",
      text: "order number is 4821",
      timeout_seconds: 1,
    });
    expect(result.success).toBe(true);
  });

  test("text appearing later succeeds (polling, not one-shot)", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForText(ctx(), {
      type: "wait_for_text",
      text: "loaded marker",
      timeout_seconds: 5,
    });
    vi.advanceTimersByTime(150);
    document.body.textContent = "loaded marker";
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result.success).toBe(true);
  });

  test("missing text hard-fails at the timeout", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForText(ctx(), {
      type: "wait_for_text",
      text: "never printed",
      timeout_seconds: 0.3,
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timed out/i);
  });
});

// ─── wait_for_url: glob ────────────────────────────────────────────────────

describe("wait_for_url: glob matching", () => {
  test("globToRegExp: `*` does not match `/`, `**` matches everything", () => {
    expect(globToRegExp("https://example.com/*").test("https://example.com/foo")).toBe(true);
    expect(globToRegExp("https://example.com/*").test("https://example.com/foo/bar")).toBe(false);
    expect(globToRegExp("https://example.com/**").test("https://example.com/foo/bar/baz")).toBe(true);
    expect(globToRegExp("https://example.com/**").test("https://example.com/")).toBe(true);
    expect(globToRegExp("https://example.com/").test("https://example.com/")).toBe(true);
    expect(globToRegExp("https://example.com/").test("https://example.com/x")).toBe(false);
    expect(globToRegExp("*://*.example.com/*").test("https://shop.example.com/items")).toBe(true);
    expect(globToRegExp("*://*.example.com/*").test("https://shop.example.com/a/b")).toBe(false);
    // regex metacharacters in the pattern are treated literally
    expect(globToRegExp("https://example.com/a+b?c").test("https://example.com/a+b?c")).toBe(true);
    expect(globToRegExp("https://example.com/a+b?c").test("https://example.com/axbc")).toBe(false);
  });

  test("wait_for_url succeeds when the URL matches the glob", async () => {
    const origin = location.origin;
    const originalHref = location.href;
    try {
      history.replaceState({}, "", `${origin}/settings/account`);
      const result = await handleWaitForUrl(ctx(), {
        type: "wait_for_url",
        url: `${origin}/settings/**`,
        timeout_seconds: 1,
      });
      expect(result.success).toBe(true);
    } finally {
      history.replaceState({}, "", originalHref);
    }
  });

  test("wait_for_url hard-fails at the timeout when the URL never matches", async () => {
    vi.useFakeTimers();
    const promise = handleWaitForUrl(ctx(), {
      type: "wait_for_url",
      url: "https://other.invalid/**",
      timeout_seconds: 0.3,
    });
    await vi.advanceTimersByTimeAsync(400);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timed out/i);
  });

  test("wait_for_url succeeds once the URL changes to match (fresh eval per poll)", async () => {
    vi.useFakeTimers();
    const origin = location.origin;
    const originalHref = location.href;
    const promise = handleWaitForUrl(ctx(), {
      type: "wait_for_url",
      url: "**/landed",
      timeout_seconds: 5,
    });
    vi.advanceTimersByTime(150);
    history.replaceState({}, "", `${origin}/landed`);
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result.success).toBe(true);
    history.replaceState({}, "", originalHref);
  });
});

// ─── wait_for_network_idle ─────────────────────────────────────────────────

describe("wait_for_network_idle: activity window", () => {
  /**
   * Stub the resource-timing API with a clock that runs in lock-step with the
   * fake timers: `performance.now()` returns the FAKED `Date.now()`, and entry
   * startTimes are captured from the same faked clock. The handler's
   * idle-window math then sees a deterministic timeline without any manual
   * clock juggling in the tests.
   */
  function stubPerformanceClock(): { setEntries: (v: number, completed?: boolean) => void } {
    let latestStart: number | null = null; // null = no entries
    let completed = true;
    vi.stubGlobal("performance", {
      now: () => Date.now(),
      getEntriesByType: () =>
        latestStart === null
          ? []
          : [{ startTime: latestStart, responseEnd: completed ? latestStart + 1 : latestStart } as PerformanceResourceTiming],
    });
    return {
      setEntries: (v: number, done = true) => {
        latestStart = v;
        completed = done;
      },
    };
  }

  test("idle immediately when no resource entries exist", async () => {
    stubPerformanceClock();
    const result = await handleWaitForNetworkIdle(ctx(), {
      type: "wait_for_network_idle",
      timeout_seconds: 1,
    });
    expect(result.success).toBe(true);
  });

  test("waits for the 500ms window to elapse after the last resource entry", async () => {
    vi.useFakeTimers();
    const clock = stubPerformanceClock();
    clock.setEntries(Date.now()); // an entry now (t=0)
    const promise = handleWaitForNetworkIdle(ctx(), {
      type: "wait_for_network_idle",
      timeout_seconds: 5,
    });
    await vi.advanceTimersByTimeAsync(450);
    // last poll at t=400: 400 < 500 → still waiting
    expect(await Promise.race([promise, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(100); // poll at t=500 crosses the window
    const result = await promise;
    expect(result.success).toBe(true);
  });

  test("a fresh resource entry resets the idle window", async () => {
    vi.useFakeTimers();
    const clock = stubPerformanceClock();
    clock.setEntries(Date.now()); // an entry at t=0
    const promise = handleWaitForNetworkIdle(ctx(), {
      type: "wait_for_network_idle",
      timeout_seconds: 5,
    });
    await vi.advanceTimersByTimeAsync(400);
    clock.setEntries(Date.now()); // a new entry lands at t=400
    await vi.advanceTimersByTimeAsync(400);
    // polls at t=500..800: 100..400ms after the last entry → still waiting
    expect(await Promise.race([promise, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(200); // poll at t=900: 500ms after t=400 → idle
    const result = await promise;
    expect(result.success).toBe(true);
  });

  test("a still-in-flight newest entry (responseEnd === startTime) is NOT idle", async () => {
    vi.useFakeTimers();
    const clock = stubPerformanceClock();
    clock.setEntries(Date.now(), false); // in-flight transfer (duration 0)
    const promise = handleWaitForNetworkIdle(ctx(), {
      type: "wait_for_network_idle",
      timeout_seconds: 5,
    });
    // Even far past the 500ms window, an in-flight newest entry must keep the
    // wait busy — the resource-timing buffer only contains completed entries,
    // so a duration-0 newest entry is the reliable busy signal.
    await vi.advanceTimersByTimeAsync(900);
    expect(await Promise.race([promise, Promise.resolve("pending")])).toBe("pending");
    clock.setEntries(Date.now(), true); // transfer completes now
    await vi.advanceTimersByTimeAsync(600); // 500ms after completion → idle
    const result = await promise;
    expect(result.success).toBe(true);
  });

  test("hard-fails at the timeout when traffic never stops", async () => {
    vi.useFakeTimers();
    const clock = stubPerformanceClock();
    clock.setEntries(Date.now()); // an entry at t=0
    const promise = handleWaitForNetworkIdle(ctx(), {
      type: "wait_for_network_idle",
      timeout_seconds: 0.5,
    });
    // keep feeding new entries every 300ms so the window never elapses
    const feeder = setInterval(() => {
      clock.setEntries(Date.now());
    }, 300);
    await vi.advanceTimersByTimeAsync(1000);
    clearInterval(feeder);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timed out/i);
  });
});

// ─── Abort mid-wait ────────────────────────────────────────────────────────

describe("wait: abort signal honored mid-wait", () => {
  test("aborting during a long wait rejects with AbortError", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = handleWaitForElement(ctx(controller.signal), {
      type: "wait_for_element",
      selector: "#never",
      state: "visible",
      timeout_seconds: 30,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
