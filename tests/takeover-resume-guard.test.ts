/**
 * Regression tests for the takeover RESUME trust guard.
 *
 * `waitForTakeoverResume` only un-pauses the agent loop when a
 * `{ type: "RESUME" }` message arrives from a trusted sender — one of our
 * own extension pages (sidepanel/options), identified by `chrome.runtime.id`
 * and the ABSENCE of a `tab` (a content script injected into a web page
 * always carries `sender.tab`). These tests lock that invariant so a future
 * refactor can't silently let a hostile page resume the loop.
 */

import { describe, test, expect } from "vitest";
import { waitForTakeoverResume } from "../src/lib/agent/loop/helpers/takeover";
import type { LoopDeps } from "../src/lib/agent/loop/types";

interface FakeChrome {
  dispatch(msg: unknown, sender?: unknown): void;
}

function installChrome(id: string): FakeChrome {
  const listeners: Array<(msg: unknown, sender?: unknown) => void> = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id,
      onMessage: {
        addListener: (fn: (msg: unknown, sender?: unknown) => void) => {
          listeners.push(fn);
        },
      },
    },
  };
  return {
    dispatch(msg: unknown, sender?: unknown) {
      for (const l of listeners) l(msg, sender);
    },
  };
}

function makeDeps(signal?: AbortSignal): LoopDeps {
  return {
    task: "regression-task",
    onEvent: () => {},
    signal,
  } as unknown as LoopDeps;
}

describe("takeover RESUME trust guard", () => {
  test("RESUME from a content script (sender.tab set) is rejected", async () => {
    const fake = installChrome("ext-id-0001");
    const controller = new AbortController();
    const p = waitForTakeoverResume(makeDeps(controller.signal), "need manual click", 0);

    // A hostile web page posts RESUME through its injected content script.
    fake.dispatch(
      { type: "RESUME" },
      { id: "ext-id-0001", tab: { id: 7, url: "https://evil.example" } },
    );

    // The untrusted message must NOT resume the loop. Force the race to
    // resolve via abort so we can assert the outcome was never "resumed".
    controller.abort();
    const result = await p;
    expect(result).not.toBe("resumed");
  });

  test("RESUME from a mismatched extension id is rejected", async () => {
    const fake = installChrome("ext-id-0001");
    const controller = new AbortController();
    const p = waitForTakeoverResume(makeDeps(controller.signal), "need manual click", 0);

    // Another extension (or a spoofed id) tries to resume.
    fake.dispatch({ type: "RESUME" }, { id: "other-ext-9999" });

    controller.abort();
    const result = await p;
    expect(result).not.toBe("resumed");
  });

  test("RESUME from a trusted sidepanel/options sender is honored", async () => {
    const fake = installChrome("ext-id-0001");
    const p = waitForTakeoverResume(makeDeps(), "need manual click", 0);

    // The legitimate sidepanel/options page: same extension id, no tab.
    fake.dispatch({ type: "RESUME" }, { id: "ext-id-0001" });

    const result = await p;
    expect(result).toBe("resumed");
  });

  test("cleanup between cases", () => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });
});
