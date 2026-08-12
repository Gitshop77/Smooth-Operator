/**
 * Mode gating of URL-loader steps (security boundary).
 *
 * URL loaders are user-authored recipes in the `open_cowork_url_loaders`
 * chrome.storage registry, dispatched through the executor's loader runner
 * after a navigation. Agent-driven navigations carry the active AgentMode
 * into the runner; every loader step is then checked with
 * `checkActionAllowed` BEFORE dispatch — mirroring the action-queue gate in
 * the loop — so a loader cannot smuggle `evaluate` / `run_script` past the
 * `canExecuteJs` boundary in standard/restricted mode.
 *
 * When no mode is provided (direct content-script callers, e.g.
 * `content-utils.ts`) loader steps dispatch ungated, exactly as before: the
 * gate is opt-in via the mode argument, never a new default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers/jsdom-layout-mock";
import { LOADER_REGISTRY_KEY } from "../src/lib/agent/dom/navigation/url-loaders";
import { executeAction } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import type { BrowserState } from "../src/lib/agent/types";

// Mock the visual overlay so `highlightElement` is a no-op (see
// tests/executor.test.ts — the real one schedules a 1200ms auto-remove timer
// that fires after jsdom teardown and logs an unhandled error).
vi.mock("../src/lib/agent/dom/overlay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agent/dom/overlay")>();
  return {
    ...actual,
    highlightElement: () => ({ remove: () => { /* no-op */ } }),
  };
});

const EVAL_LOADER = {
  "a.yaml": [
    "match:",
    "  domain: open-cowork.test",
    "steps:",
    "  - type: evaluate",
    '    code: "1 + 1"',
  ].join("\n"),
};

const RUN_SCRIPT_LOADER = {
  "a.yaml": [
    "match:",
    "  domain: open-cowork.test",
    "steps:",
    "  - type: run_script",
    "    script: '{\"name\":\"benign\",\"steps\":[{\"action\":\"get_page_info\"}]}'",
  ].join("\n"),
};

const CLICK_INPUT_LOADER = {
  "a.yaml": [
    "match:",
    "  domain: open-cowork.test",
    "steps:",
    "  - type: click",
    "    index: 1",
    "  - type: input",
    "    index: 2",
    "    text: hello",
    "    clear: true",
  ].join("\n"),
};

const GET_PAGE_INFO_LOADER = {
  "a.yaml": [
    "match:",
    "  domain: open-cowork.test",
    "steps:",
    "  - type: get_page_info",
  ].join("\n"),
};

function installLoaderRegistry(registry: Record<string, string>): void {
  const local = new Map<string, unknown>([[LOADER_REGISTRY_KEY, registry]]);
  (globalThis as Record<string, unknown>).chrome = makeChromeStorageMock(local, new Map());
}

/** Run the loader through a same-document hash navigation supported by jsdom. */
function runLoader(registry: Record<string, string>, mode?: "restricted" | "standard" | "full_agentic") {
  installLoaderRegistry(registry);
  return executeAction(
    { type: "navigate", url: "https://open-cowork.test/#loader", new_tab: false },
    makeState(),
    undefined,
    undefined,
    mode,
  );
}

describe("URL-loader steps respect the agent mode gate", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
    document.body.innerHTML = "";
  });

  it("blocks an evaluate loader step in standard mode before it executes", async () => {
    const res = await runLoader(EVAL_LOADER, "standard");

    // The navigation itself succeeds; the loader hook failure is reported
    // in-message. The step must be refused by the mode gate (NOT by the
    // evaluate handler's domain gate — that would mean it was dispatched).
    expect(res.success).toBe(true);
    expect(res.message).toContain("FAILED: step 1 failed");
    expect(res.message).toContain("BLOCKED: JavaScript execution is not allowed in standard mode");
    expect(res.message).not.toContain("JavaScript executed");
  });

  it("blocks an evaluate loader step in restricted mode too", async () => {
    const res = await runLoader(EVAL_LOADER, "restricted");

    expect(res.message).toContain("BLOCKED: JavaScript execution is not allowed in restricted mode");
  });

  it("blocks a run_script loader step in restricted and standard modes", async () => {
    const restricted = await runLoader(RUN_SCRIPT_LOADER, "restricted");
    expect(restricted.message).toContain("BLOCKED: Script execution is not allowed in restricted mode");

    const standard = await runLoader(RUN_SCRIPT_LOADER, "standard");
    expect(standard.message).toContain("BLOCKED: Script execution is not allowed in standard mode");
  });

  it("allows a run_script loader step in full_agentic mode", async () => {
    const res = await runLoader(RUN_SCRIPT_LOADER, "full_agentic");

    expect(res.success).toBe(true);
    expect(res.message).toContain("ran 1 step(s)");
    expect(res.message).not.toContain("BLOCKED");
  });

  it("passes benign loader steps (click, input) through in standard mode", async () => {
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void { /* no-op */ };
    installJsdomLayoutMock();
    try {
      document.body.innerHTML = "";
      installLoaderRegistry(CLICK_INPUT_LOADER);
      // The click handler only uses the CDP strategy in a real extension
      // context; without `chrome.runtime.id` it falls back to the native
      // DOM click, which is what jsdom can actually execute.
      (globalThis.chrome as { runtime: { id?: string } }).runtime.id = undefined;
      const button = document.createElement("button");
      button.textContent = "Go";
      const input = document.createElement("input");
      document.body.append(button, input);
      const state = makeState({ selectorMap: { 1: button, 2: input } }) as BrowserState;

      const res = await executeAction(
        { type: "navigate", url: "https://open-cowork.test/#loader", new_tab: false },
        state,
        undefined,
        undefined,
        "standard",
      );

      expect(res.success).toBe(true);
      expect(res.message).toContain("ran 2 step(s)");
      expect(res.message).not.toContain("BLOCKED");
    } finally {
      restoreJsdomLayoutMock();
      if (origScrollIntoView) {
        HTMLElement.prototype.scrollIntoView = origScrollIntoView;
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });
});

describe("URL-loader steps stay ungated without a mode (old behavior)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
    document.body.innerHTML = "";
  });

  it("dispatches an evaluate loader step when agentMode is undefined", async () => {
    const res = await runLoader(EVAL_LOADER);

    // The step IS dispatched — it reaches the evaluate handler, which then
    // fails closed on its own domain allowlist gate (no allowlist in tests).
    // The absence of the mode-gate text proves no mode check was applied.
    expect(res.success).toBe(true);
    expect(res.message).toContain("FAILED: step 1 failed");
    expect(res.message).toContain("BLOCKED evaluate on");
    expect(res.message).not.toContain("is not allowed in");
  });

  it("dispatches benign loader steps successfully when agentMode is undefined", async () => {
    const res = await runLoader(GET_PAGE_INFO_LOADER);

    expect(res.success).toBe(true);
    expect(res.message).toContain("ran 1 step(s)");
    expect(res.message).not.toContain("BLOCKED");
  });
});
