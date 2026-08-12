/**
 * Phase 13 — accessibility foundation tests (jsdom level).
 *
 * Covers:
 * 1. Reduced-motion gating (prefersReducedMotion honors matchMedia).
 * 2. Live regions (announce creates sr-only role=alert/status regions and
 *    reuses the static markup shipped in sidepanel.html / options.html).
 * 3. Focus management (moveFocusToId / moveFocusTo / trapTab).
 * 4. axe-style jsdom assertions for the critical flows — run start/stop,
 *    provider selection, schedule create/delete, error notices — with ZERO
 *    serious/critical findings (see tests/helpers/a11y-rules.ts).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import { runA11yRules, seriousViolations } from "./helpers/a11y-rules";
import {
  announce,
  moveFocusTo,
  moveFocusToId,
  prefersReducedMotion,
  trapTab,
} from "../src/extension/accessibility";

const sidepanelBody = /<body>([\s\S]*?)<\/body>/.exec(
  readFileSync("src/extension/sidepanel.html", "utf8"),
)![1];
const optionsBody = /<body>([\s\S]*?)<\/body>/.exec(
  readFileSync("src/extension/options.html", "utf8"),
)![1];

interface MatchMediaStub {
  matches: boolean;
  media: string;
  onchange: null;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

function installMatchMedia(matches: boolean): MatchMediaStub {
  const stub: MatchMediaStub = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  window.matchMedia = vi.fn().mockReturnValue(stub) as unknown as typeof window.matchMedia;
  return stub;
}

function mountSidepanel(): void {
  document.body.innerHTML = sidepanelBody;
}

function mountOptions(): void {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: "test",
      lastError: undefined,
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve({ ok: true }),
    },
    storage: {
      local: makeChromeStorageMock(local, session).storage.local,
      session: {
        get: (_k: unknown, cb?: (r: Record<string, unknown>) => void) => {
          const r: Record<string, unknown> = {};
          cb?.(r);
          return Promise.resolve(r);
        },
      },
    },
  } as unknown as typeof chrome;
  document.body.innerHTML = optionsBody;
}

describe("Phase 13 — reduced motion + focus + live regions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  test("prefersReducedMotion honors matchMedia in both directions", () => {
    installMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    installMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  test("prefersReducedMotion degrades to false when matchMedia throws", () => {
    window.matchMedia = (() => {
      throw new Error("matchMedia missing");
    }) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  test("announce creates an assertive sr-only alert region and fills it", () => {
    announce("Connection test failed: boom", { assertive: true });
    const region = document.getElementById("ocLiveAlert");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("alert");
    expect(region?.getAttribute("aria-live")).toBe("assertive");
    expect(region?.getAttribute("aria-atomic")).toBe("true");
    expect(region?.className).toContain("sr-only");
    expect(region?.textContent).toBe("Connection test failed: boom");
  });

  test("announce polite uses role=status and reuses the same region", () => {
    announce("Saved");
    announce("Saved again");
    expect(document.getElementById("ocLiveStatus")?.getAttribute("role")).toBe("status");
    expect(document.getElementById("ocLiveStatus")?.textContent).toBe("Saved again");
    expect(document.querySelectorAll("#ocLiveStatus").length).toBe(1);
  });

  test("pre-existing static regions are reused (sidepanel.html markup)", () => {
    mountSidepanel();
    const sideAlert = document.getElementById("runErrorLive");
    expect(sideAlert?.getAttribute("role")).toBe("alert");
    announce("Agent cancelled", { assertive: true });
    expect(sideAlert?.textContent).toBe("Agent cancelled");
  });

  test("moveFocusToId / moveFocusTo manage focus", () => {
    document.body.innerHTML =
      `<button id="a">A</button><button id="b" disabled>B</button><div id="box">` +
      `<button class="x">X</button></div>`;
    expect(moveFocusToId("a")).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    expect(moveFocusToId("missing")).toBe(false);
    expect(moveFocusTo(document.getElementById("b"))).toBe(false); // disabled → no focus
    expect(moveFocusTo(document.getElementById("b"), document.getElementById("box") ?? undefined)).toBe(true);
    expect(document.activeElement?.textContent).toBe("X");
  });

  test("trapTab cycles focus inside the container and blocks Tab out", () => {
    document.body.innerHTML = `<div id="dialog"><button id="f">First</button><button id="l">Last</button></div>`;
    const dialog = document.getElementById("dialog") as HTMLElement;
    const first = document.getElementById("f") as HTMLElement;
    const last = document.getElementById("l") as HTMLElement;

    // From the first element, plain Tab moves forward naturally (no wrap).
    first.focus();
    const tabForward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trapTab(dialog, tabForward);
    expect(tabForward.defaultPrevented).toBe(false);

    // From the last element, plain Tab wraps to the first.
    last.focus();
    const tabWrap = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trapTab(dialog, tabWrap);
    expect(tabWrap.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("f");

    // From the first element, Shift+Tab wraps to the last.
    first.focus();
    const tabBack = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    trapTab(dialog, tabBack);
    expect(tabBack.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("l");

    // Non-Tab keys pass through untouched.
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    trapTab(dialog, esc);
    expect(esc.defaultPrevented).toBe(false);
  });

  test("trapTab with zero focusables moves focus to the container", () => {
    document.body.innerHTML = `<div id="empty" tabindex="-1"></div>`;
    const container = document.getElementById("empty") as HTMLElement;
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trapTab(container, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container);
  });

  test("trapTab honors an injected doc (M6: no ambient-document dependency)", () => {
    // A detached createHTMLDocument ignores focus(); an iframe document keeps
    // a real browsing context so focus() resolves inside it.
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc2 = iframe.contentDocument as Document;
    doc2.body.innerHTML =
      `<div id="dialog"><button id="f">First</button><button id="l">Last</button></div>`;
    const dialog = doc2.getElementById("dialog") as HTMLElement;
    const first = doc2.getElementById("f") as HTMLElement;
    const last = doc2.getElementById("l") as HTMLElement;

    // From the last element, plain Tab wraps to the first — resolved through
    // the INJECTED document, not the ambient one.
    last.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trapTab(dialog, ev, doc2);
    expect(ev.defaultPrevented).toBe(true);
    expect(doc2.activeElement).toBe(first);
    // The ambient document never received focus.
    expect(document.activeElement).not.toBe(first);
  });
});


describe("Phase 13 — axe-style checks on critical flows (no serious/critical findings)", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("run start/stop (side panel): idle and active states pass with no serious findings", () => {
    mountSidepanel();
    const idle = runA11yRules(document, { requireLiveRegions: { alertId: "runErrorLive" } });
    expect(seriousViolations(idle)).toEqual([]);
    expect(idle.filter((v) => v.rule === "live-region")).toEqual([]);

    // Simulate an active run: Stop becomes keyboard-reachable and labeled.
    const stop = document.getElementById("stopBtn") as HTMLButtonElement;
    stop.disabled = false;
    stop.setAttribute("aria-label", "Stop agent");
    document.getElementById("statusDot")!.dataset.status = "thinking";
    document.getElementById("statusLabel")!.textContent = "Thinking…";

    const active = runA11yRules(document, { requireLiveRegions: { alertId: "runErrorLive" } });
    expect(seriousViolations(active)).toEqual([]);
    expect(stop.disabled).toBe(false);
    expect(stop.tabIndex).toBe(0); // keyboard-reachable exactly while active
  });

  test("provider selection + error notice (Options): diagnostics failure announces and stays clean", async () => {
    mountOptions();
    const { connectionDiagnosticsStore } = await import("../src/extension/options/stores");
    const { renderDiagnosticsFromStore } = await import("../src/extension/options/provider-config-ui");

    connectionDiagnosticsStore.dispatch({
      type: "DIAGNOSTICS_TEST_FAILED",
      // Match the store's current generation (module wiring may invalidate).
      generation: connectionDiagnosticsStore.getState().current.generation,
      error: "Connection refused (sanitized)",
    });
    renderDiagnosticsFromStore();

    const region = document.getElementById("errorMessage");
    expect(region?.textContent).toContain("Connection test failed");
    expect(region?.getAttribute("role")).toBe("alert");
    expect(document.getElementById("testResult")?.textContent).toContain("Connection refused");

    const violations = runA11yRules(document, {
      requireLiveRegions: { statusId: "statusMessage", alertId: "errorMessage" },
    });
    expect(seriousViolations(violations)).toEqual([]);
    expect(violations.filter((v) => v.rule === "live-region")).toEqual([]);
  });

  test("schedule create/delete (Options): rendered rows + post-delete focus pass", async () => {
    mountOptions();
    const { renderSchedule } = await import("../src/extension/options/scheduled-tasks");
    await renderSchedule();

    const initial = runA11yRules(document, {
      requireLiveRegions: { statusId: "statusMessage", alertId: "errorMessage" },
    });
    expect(seriousViolations(initial)).toEqual([]);

    // Render a row, then run the keyboard delete flow; the Phase 14
    // destructive-action gate requires explicit confirmation first, then focus
    // must land on the add-prompt (Phase 12 contract) and the DOM must stay clean.
    const taskList = [
      {
        id: "t1", task: "daily summary", schedule: { type: "daily", hour: 9, minute: 0 },
        enabled: true, createdAt: 100, revision: 1,
      },
    ];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: "test",
        lastError: undefined,
        onMessage: { addListener: () => {} },
        sendMessage: (msg: unknown) => {
          const m = msg as { type: string; command: { kind: string } };
          if (m.command?.kind === "list") return Promise.resolve({ ok: true, tasks: taskList });
          if (m.command?.kind === "delete") return Promise.resolve({ ok: true, tasks: [] });
          return Promise.resolve({ ok: true, tasks: taskList });
        },
      },
      storage: {
        local: {
          get: (_k: unknown, cb?: (r: Record<string, unknown>) => void) => {
            const r: Record<string, unknown> = {};
            cb?.(r);
            return Promise.resolve(r);
          },
        },
      },
    } as unknown as typeof chrome;
    await renderSchedule();
    const delBtn = document.querySelector<HTMLButtonElement>("button.schedule-delete");
    expect(delBtn).not.toBeNull();
    delBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    delBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    // Confirmation modal is open and the delete command has NOT fired yet.
    const overlay = document.querySelector<HTMLDivElement>(".modal-overlay");
    expect(overlay).not.toBeNull();
    // Danger confirms carry an anti-misclick delay; wait it out, then confirm.
    await new Promise((r) => setTimeout(r, 250));
    const footer = overlay?.querySelectorAll<HTMLButtonElement>(".modal-footer button");
    footer?.[footer.length - 1]?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement?.id).toBe("scheduleTask");

    const after = runA11yRules(document, {
      requireLiveRegions: { statusId: "statusMessage", alertId: "errorMessage" },
    });
    expect(seriousViolations(after)).toEqual([]);
  });

  test("error notices (both surfaces) announce assertively via role=alert", async () => {
    mountSidepanel();
    const { setLifecycle } = await import("../src/extension/sidepanel/lifecycle");
    setLifecycle("error");
    const sideAlert = document.getElementById("runErrorLive");
    expect(sideAlert?.textContent).toContain("error");
    expect(sideAlert?.getAttribute("role")).toBe("alert");

    mountOptions();
    const { announce: announceDirect } = await import("../src/extension/accessibility");
    announceDirect("Could not load scheduled tasks: storage unavailable", { assertive: true });
    // On the Options page the static #errorMessage region is used.
    const errRegion = document.getElementById("errorMessage");
    expect(errRegion?.textContent).toContain("Could not load scheduled tasks");
    expect(errRegion?.getAttribute("role")).toBe("alert");
  });
});

