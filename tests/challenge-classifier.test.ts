/**
 * Tests for the read-only vendor-precise challenge classifier
 * (`src/lib/agent/dom/challenge-snapshot.ts`).
 *
 * Contract (mirrors the upstream challenge-detector contracts):
 * - Bounded output: 20 matches / 8 evidence strings / 8 frames / 8 elements
 *   per match / 100 snapshot items / 256-char resource paths.
 * - Read-only: no DOM mutation, no network requests, hidden generic markers
 *   skipped, zero-size elements excluded, `srcdoc` iframes ignored.
 * - Eval failure is distinct from a clean miss: `status: "unknown"` vs
 *   `status: "absent"` with `matches: []`.
 * - `detect_challenge.scroll_into_view` is a STRICT boolean (rejects "true").
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifyChallengeSnapshot,
  detectChallenges,
  collectChallengeSnapshot,
  firstVisibleScrollTarget,
  scrollIntoViewFromSnapshot,
  type ChallengeMatch,
  type ChallengeDetectionResult,
} from "../src/lib/agent/dom/challenge-snapshot";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import { executeAction } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers/make-state";
import { installJsdomLayoutMock, restoreJsdomLayoutMock } from "./helpers/jsdom-layout-mock";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentAction, ActionResult, LogEvent } from "../src/lib/agent/types";

const ABSENT_RESULT = { detected: false, status: "absent", matches: [] as ChallengeMatch[] };
const UNKNOWN_RESULT = { detected: false, status: "unknown", matches: [] as ChallengeMatch[] };

const DOCUMENTED_VENDORS = new Set([
  "altcha",
  "arkose",
  "aws_waf",
  "friendlycaptcha",
  "geetest",
  "hcaptcha",
  "recaptcha",
  "turnstile",
]);

const TURNSTILE_RESOURCE = {
  host: "challenges.cloudflare.com",
  path: "/turnstile/v0/api.js",
};
const ARKOSE_RESOURCE = { host: "iframe.arkoselabs.com", path: "/redacted" };

interface Match {
  vendor: string;
  confidence: string;
  locations: string[];
  evidence: string[];
  frames?: Array<Record<string, unknown>>;
  elements?: Array<Record<string, unknown>>;
}

function matchesByVendor(result: ChallengeDetectionResult): Record<string, Match> {
  return Object.fromEntries(
    result.matches.map((m) => [
      m.vendor,
      {
        ...m,
        frames: m.frames as Match["frames"],
        elements: m.elements as Match["elements"],
      },
    ]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Pure classifier: upstream contract ports ───────────────────────────────

describe("classifyChallengeSnapshot — documented resource catalogue + sanitisation", () => {
  test("recognises documented hosts/paths and redacts arkose keys + query strings", () => {
    const result = classifyChallengeSnapshot({
      iframes: [
        {
          resource: {
            host: "CHALLENGES.CLOUDFLARE.COM",
            path: "/turnstile/v0/api.js?auth_token=must-not-appear#secret",
          },
          bounding_box: { x: 1, y: 2, width: 300, height: 65 },
        },
        {
          resource: {
            host: "challenges.cloudflare.com",
            path: "/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1",
          },
        },
        {
          resource: { host: "www.recaptcha.net", path: "/recaptcha/api2/anchor" },
        },
        {
          resource: {
            host: "iframe.arkoselabs.com",
            path: "/TEST_PUBLIC_KEY_DO_NOT_USE/lightbox.html",
          },
        },
      ],
      scripts: [
        { resource: { host: "www.google.com", path: "/recaptcha/api.js?render=explicit" } },
        { resource: { host: "js.hcaptcha.com", path: "/1/api.js" } },
        {
          resource: {
            host: "cdn.jsdelivr.net",
            path: "/npm/@friendlycaptcha/sdk/site.min.js",
          },
        },
        {
          resource: {
            host: "client-api.arkoselabs.com",
            path: "/v2/TEST_PUBLIC_KEY_DO_NOT_USE/api.js",
          },
        },
      ],
    });

    const matches = matchesByVendor(result);
    expect(result.detected).toBe(true);
    expect(result.status).toBe("present");
    expect(new Set(Object.keys(matches))).toEqual(
      new Set(["turnstile", "recaptcha", "arkose", "hcaptcha", "friendlycaptcha"]),
    );
    expect(matches.turnstile.confidence).toBe("high");
    expect(matches.turnstile.frames?.[0]).toEqual({
      ...TURNSTILE_RESOURCE,
      bounding_box: { x: 1, y: 2, width: 300, height: 65 },
    });
    expect(matches.arkose.frames?.[0]).toEqual(ARKOSE_RESOURCE);
    expect(matches.friendlycaptcha.confidence).toBe("medium");
    // Query strings, fragments, and arkose site keys must never surface.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("auth_token");
    expect(serialized).not.toContain("must-not-appear");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("TEST_PUBLIC_KEY_DO_NOT_USE");
  });
});

describe("classifyChallengeSnapshot — widget markers, globals, generic visibility", () => {
  test("known markers match regardless of visibility; generic requires visible; globals via hasOwnProperty", () => {
    const result = classifyChallengeSnapshot({
      elements: [
        { marker: "turnstile", visible: true, bounding_box: { x: 1, y: 1, width: 1, height: 1 } },
        { marker: "recaptcha", visible: false, bounding_box: { x: 2, y: 2, width: 2, height: 2 } },
        { marker: "hcaptcha", visible: true, bounding_box: { x: 3, y: 3, width: 3, height: 3 } },
        { marker: "friendlycaptcha", visible: true, bounding_box: { x: 4, y: 4, width: 4, height: 4 } },
        { marker: "altcha", visible: true, bounding_box: { x: 5, y: 5, width: 5, height: 5 } },
        { marker: "generic-challenge", visible: true, bounding_box: { x: 6, y: 6, width: 6, height: 6 } },
        { marker: "generic-challenge", visible: false, bounding_box: { x: 7, y: 7, width: 7, height: 7 } },
      ],
      globals: { aws_waf: true, geetest: true },
    });

    const matches = matchesByVendor(result);
    expect(new Set(Object.keys(matches))).toEqual(
      new Set(["altcha", "aws_waf", "friendlycaptcha", "geetest", "hcaptcha", "recaptcha", "turnstile", "unknown"]),
    );
    expect(matches.unknown.confidence).toBe("low");
    expect(matches.unknown.elements).toEqual([
      { bounding_box: { x: 6, y: 6, width: 6, height: 6 } },
    ]);
    expect(matches.aws_waf.confidence).toBe("high");
    expect(matches.geetest.confidence).toBe("medium");
    expect(matches.recaptcha.confidence).toBe("high");
  });
});

describe("classifyChallengeSnapshot — malformed data, geometry, deduplication, bounds", () => {
  test("bad boxes dropped, userinfo rejected, caps enforced, exact duplicates merged", () => {
    const recognised = classifyChallengeSnapshot({
      iframes: [
        {
          resource: TURNSTILE_RESOURCE,
          bounding_box: { x: Number.NaN, y: 0, width: 1, height: 1 },
        },
        {
          resource: { host: "attacker@challenges.cloudflare.com", path: "/turnstile/v0/api.js" },
        },
        { resource: { host: 1, path: [] } },
      ],
      elements: [
        {
          marker: "generic-challenge",
          visible: true,
          bounding_box: { x: true, y: 0, width: 1, height: 1 },
        },
      ],
      globals: { aws_waf: "true", geetest: 1 },
    });
    const turnstile = matchesByVendor(recognised).turnstile;
    expect("bounding_box" in (turnstile.frames?.[0] ?? {})).toBe(false);
    expect(turnstile.elements).toBeUndefined();
    expect(matchesByVendor(recognised).unknown.elements).toBeUndefined();

    const duplicateFrames = Array.from({ length: 9 }, (_, index) => ({
      resource: { host: "challenges.cloudflare.com", path: `/turnstile/${index}` },
    }));
    const deduplicated = classifyChallengeSnapshot({ iframes: [...duplicateFrames, duplicateFrames[0]] });
    expect(matchesByVendor(deduplicated).turnstile.frames?.length).toBe(8);

    const sameBox = { x: 1, y: 2, width: 300, height: 65 };
    const duplicateResource = { resource: TURNSTILE_RESOURCE, bounding_box: sameBox };
    const exactDuplicates = classifyChallengeSnapshot({ iframes: [duplicateResource, duplicateResource] });
    expect(matchesByVendor(exactDuplicates).turnstile.frames?.length).toBe(1);

    const distinctGeometry = classifyChallengeSnapshot({
      iframes: [duplicateResource, { resource: TURNSTILE_RESOURCE, bounding_box: { ...sameBox, x: 2 } }],
    });
    expect(matchesByVendor(distinctGeometry).turnstile.frames?.length).toBe(2);

    // 100-item cap: the 101st candidate is never inspected.
    const overLimit = Array.from({ length: 100 }, () => ({
      resource: { host: "example.invalid", path: "/" },
    }));
    overLimit.push({ resource: TURNSTILE_RESOURCE });
    expect(classifyChallengeSnapshot({ iframes: overLimit })).toEqual(ABSENT_RESULT);

    const elementsOverLimit = Array.from({ length: 100 }, () => ({ marker: "unrelated", visible: true }));
    elementsOverLimit.push({ marker: "turnstile", visible: true });
    expect(classifyChallengeSnapshot({ elements: elementsOverLimit })).toEqual(ABSENT_RESULT);
  });
});

describe("classifyChallengeSnapshot — resource boundaries and false positives", () => {
  test("lookalike hosts/paths do not match", () => {
    const unrecognised = [
      { host: "cdn.challenges.cloudflare.com", path: "/turnstile/v0/api.js" },
      { host: "www.google.com.evil.invalid", path: "/recaptcha/api.js" },
      { host: "assets.recaptcha.net", path: "/recaptcha/api.js" },
      { host: "cdn.js.hcaptcha.com", path: "/1/api.js" },
      { host: "challenges.cloudflare.com", path: "/other/path" },
      { host: "www.google.com", path: "/not-recaptcha/api.js" },
      { host: "js.hcaptcha.com", path: "/2/api.js" },
      { host: "cdn.jsdelivr.net", path: "/npm/friendlycaptcha/sdk.js" },
    ];
    expect(
      classifyChallengeSnapshot({ scripts: unrecognised.map((resource) => ({ resource })) }),
    ).toEqual(ABSENT_RESULT);
  });

  test("resource paths are truncated to 256 chars with no query/fragment leak", () => {
    const longResource = {
      host: "challenges.cloudflare.com",
      path: "/turnstile/" + "x".repeat(512) + "?auth_token=must-not-appear#secret",
    };
    const result = classifyChallengeSnapshot({ iframes: [{ resource: longResource }] });
    const returnedPath = matchesByVendor(result).turnstile.frames?.[0]?.path as string;
    expect(returnedPath.length).toBe(256);
    expect(returnedPath).not.toContain("auth_token");
    expect(returnedPath).not.toContain("secret");
  });
});

describe("classifyChallengeSnapshot — absent and malformed snapshots", () => {
  test("non-snapshot inputs produce the stable empty schema", () => {
    expect(classifyChallengeSnapshot(null)).toEqual(ABSENT_RESULT);
    expect(
      classifyChallengeSnapshot({ iframes: [null, { resource: { host: 1, path: [] } }] }),
    ).toEqual(ABSENT_RESULT);
    expect(
      classifyChallengeSnapshot({ iframes: "not-a-list", scripts: {}, elements: null, globals: [] }),
    ).toEqual(ABSENT_RESULT);
  });
});

// ─── firstVisibleScrollTarget (pure) ────────────────────────────────────────

describe("firstVisibleScrollTarget", () => {
  test("picks the first visible detected iframe with geometry", () => {
    const target = firstVisibleScrollTarget({
      iframes: [
        { resource: { host: "example.invalid", path: "/" }, visible: true, bounding_box: { x: 1, y: 1, width: 1, height: 1 } },
        { resource: TURNSTILE_RESOURCE, visible: true, bounding_box: { x: 10, y: 1200, width: 300, height: 65 } },
      ],
    });
    expect(target).toEqual({ x: 10, y: 1200, width: 300, height: 65 });
  });

  test("falls back to visible known/generic elements when no vendor iframe is visible", () => {
    const target = firstVisibleScrollTarget({
      iframes: [
        { resource: TURNSTILE_RESOURCE, visible: false, bounding_box: { x: 1, y: 1, width: 1, height: 1 } },
      ],
      elements: [
        { marker: "turnstile", visible: false, bounding_box: { x: 2, y: 2, width: 2, height: 2 } },
        { marker: "generic-challenge", visible: true, bounding_box: { x: 3, y: 3, width: 3, height: 3 } },
      ],
    });
    expect(target).toEqual({ x: 3, y: 3, width: 3, height: 3 });
  });

  test("returns null when nothing detected is visible with geometry", () => {
    expect(
      firstVisibleScrollTarget({
        iframes: [{ resource: TURNSTILE_RESOURCE, visible: false, bounding_box: { x: 1, y: 1, width: 1, height: 1 } }],
        elements: [{ marker: "unrelated", visible: true, bounding_box: { x: 2, y: 2, width: 2, height: 2 } }],
      }),
    ).toBeNull();
    expect(firstVisibleScrollTarget(null)).toBeNull();
  });
});

// ─── DOM integration (collectChallengeSnapshot / detectChallenges) ──────────

function installChallengeFixture(): void {
  document.body.innerHTML = `
    <div id="sentinel" data-sentinel="1">keep me</div>
    <div class="cf-turnstile" data-sitekey="TEST_PUBLIC_KEY_DO_NOT_USE"></div>
    <div class="g-recaptcha" data-sitekey="TEST_PUBLIC_KEY_DO_NOT_USE"></div>
    <input type="hidden" name="g-recaptcha-response" value="mock-response">
    <div class="h-captcha" data-sitekey="TEST_PUBLIC_KEY_DO_NOT_USE"></div>
    <div class="frc-captcha"></div>
    <altcha-widget data-challenge="auto"></altcha-widget>
    <iframe title="captcha challenge" src="https://challenges.cloudflare.com/turnstile/v0/api.js?auth_token=must-not-appear#secret"></iframe>
    <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
    <iframe src="https://js.hcaptcha.com/1/api.js"></iframe>
    <iframe src="https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk/site.min.js"></iframe>
    <iframe srcdoc="<html><body>inline</body></html>"></iframe>
    <iframe src="https://iframe.arkoselabs.com/TEST_PUBLIC_KEY_DO_NOT_USE/lightbox.html"></iframe>
    <script src="https://www.google.com/recaptcha/api.js?render=explicit"></script>
    <script src="https://js.hcaptcha.com/1/api.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@friendlycaptcha/sdk/site.min.js"></script>
    <script src="https://client-api.arkoselabs.com/v2/TEST_PUBLIC_KEY_DO_NOT_USE/api.js"></script>
    <div role="dialog" aria-label="captcha verification" style="display:none"></div>
    <div data-captcha>implicit challenge</div>
  `;
  Object.defineProperty(window, "AwsWafCaptcha", { value: function awsWafCaptcha() {}, configurable: true });
  Object.defineProperty(window, "initGeetest4", { value: function initGeetest4() {}, configurable: true });
}

describe("collectChallengeSnapshot — DOM collection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
  });
  afterEach(() => {
    restoreJsdomLayoutMock();
    delete (window as unknown as Record<string, unknown>).AwsWafCaptcha;
    delete (window as unknown as Record<string, unknown>).initGeetest4;
  });

  test("collects elements, resources, and globals without mutating the page", () => {
    installChallengeFixture();
    const before = document.body.innerHTML;

    const snapshot = collectChallengeSnapshot();

    // The page is untouched: no nodes added, removed, or re-written.
    expect(document.body.innerHTML).toBe(before);
    const sentinel = document.querySelector("#sentinel");
    expect(sentinel?.getAttribute("data-sentinel")).toBe("1");
    expect(sentinel?.textContent).toBe("keep me");

    const markers = snapshot.elements.map((e) => e.marker);
    expect(markers.filter((m) => m === "turnstile").length).toBe(1);
    expect(markers.filter((m) => m === "recaptcha").length).toBe(2); // div + hidden input
    expect(markers).toContain("hcaptcha");
    expect(markers).toContain("friendlycaptcha");
    expect(markers).toContain("altcha");
    // Generic markers: the titled iframe + the [data-captcha] div + the
    // altcha-widget (it also matches the generic [data-challenge] selector —
    // a node can match multiple selectors, mirroring the upstream collector).
    // The display:none dialog is zero-size → skipped.
    expect(markers.filter((m) => m === "generic-challenge").length).toBe(3);

    expect(snapshot.globals.aws_waf).toBe(true);
    expect(snapshot.globals.geetest).toBe(true);

    // srcdoc iframe has no src → resource null.
    expect(snapshot.iframes.some((f) => f.resource === null)).toBe(true);
    // Query string must never survive into a resource path.
    expect(
      snapshot.iframes.some(
        (f) => f.resource?.host === "challenges.cloudflare.com" && f.resource.path === "/turnstile/v0/api.js",
      ),
    ).toBe(true);
    expect(
      snapshot.iframes.some((f) => f.resource?.path.includes("auth_token")),
    ).toBe(false);
    expect(snapshot.scripts.length).toBeGreaterThanOrEqual(4);
  });

  test("caps the snapshot at 100 iframes", () => {
    for (let i = 0; i < 101; i++) {
      const f = document.createElement("iframe");
      f.src = `https://example.invalid/${i}`;
      document.body.appendChild(f);
    }
    const snapshot = collectChallengeSnapshot();
    expect(snapshot.iframes.length).toBe(100);
  });
});

describe("detectChallenges — DOM integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
  });
  afterEach(() => {
    restoreJsdomLayoutMock();
    delete (window as unknown as Record<string, unknown>).AwsWafCaptcha;
    delete (window as unknown as Record<string, unknown>).initGeetest4;
  });

  test("detects the full 9-vendor fixture with a bounded, redacted result", () => {
    installChallengeFixture();

    const result = detectChallenges();
    const matches = matchesByVendor(result);

    expect(result.detected).toBe(true);
    expect(result.status).toBe("present");
    expect(new Set(Object.keys(matches))).toEqual(new Set([...DOCUMENTED_VENDORS, "unknown"]));
    expect(matches.turnstile.confidence).toBe("high");
    expect(matches.geetest.confidence).toBe("medium");
    expect(matches.unknown.confidence).toBe("low");
    expect(matches.arkose.frames?.[0]).toMatchObject(ARKOSE_RESOURCE);
    expect(JSON.stringify(result)).not.toContain("TEST_PUBLIC_KEY_DO_NOT_USE");
    expect(JSON.stringify(result)).not.toContain("auth_token");
    expect(JSON.stringify(result)).not.toContain("must-not-appear");
  });

  test("makes no network requests (fetch / XHR silent)", async () => {
    installChallengeFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let xhrInstances = 0;
    class FakeXHR {
      open = vi.fn();
      send = vi.fn();
      constructor() {
        xhrInstances++;
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);

    detectChallenges();
    detectChallenges({ scrollIntoView: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrInstances).toBe(0);
  });

  test("hidden known-vendor widgets still detected; hidden generic markers excluded", () => {
    document.body.innerHTML = `
      <div class="cf-turnstile" style="display:none"></div>
      <div role="dialog" aria-label="captcha" style="display:none"></div>
    `;
    const result = detectChallenges();
    const matches = matchesByVendor(result);
    expect(matches.turnstile).toBeDefined();
    expect(matches.unknown).toBeUndefined();
  });

  test("eval failure is distinct from a clean miss", () => {
    const spy = vi.spyOn(document, "querySelectorAll").mockImplementation(() => {
      throw new Error("fixture evaluation error");
    });
    expect(detectChallenges()).toEqual(UNKNOWN_RESULT);
    expect(detectChallenges({ scrollIntoView: true })).toEqual({
      ...UNKNOWN_RESULT,
      scrolled_into_view: false,
    });
    spy.mockRestore();

    document.body.innerHTML = "<p>no challenges here</p>";
    expect(detectChallenges()).toEqual(ABSENT_RESULT);
  });
});

describe("detectChallenges — scroll_into_view", () => {
  let scrollY: number;
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
    scrollY = 0;
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 3000,
    });
    vi.spyOn(window, "scrollTo").mockImplementation((_x: number, y: number) => {
      scrollY = y;
    });
  });
  afterEach(() => {
    restoreJsdomLayoutMock();
    vi.restoreAllMocks();
  });

  test("centers the first visible detected widget with a clamped scroll offset", () => {
    const iframe = document.createElement("iframe");
    iframe.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    document.body.appendChild(iframe);
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 1200, width: 300, height: 65,
      top: 1200, left: 10, right: 310, bottom: 1265,
      toJSON: () => ({}),
    });

    const result = detectChallenges({ scrollIntoView: true }) as { scrolled_into_view?: boolean };

    expect(result.scrolled_into_view).toBe(true);
    // desiredScrollY = clamp(1200 - (800 - 65) / 2, 0, 3000 - 800) = 832.5
    expect(window.scrollTo).toHaveBeenCalledWith(0, 832.5);
  });

  test("hidden widgets are not scrolled to, but detection still succeeds", () => {
    const div = document.createElement("div");
    div.className = "cf-turnstile";
    div.style.display = "none";
    document.body.appendChild(div);

    const result = detectChallenges({ scrollIntoView: true }) as {
      detected: boolean;
      scrolled_into_view?: boolean;
    };
    expect(result.detected).toBe(true);
    expect(result.scrolled_into_view).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  test("scrollIntoViewFromSnapshot validates the target box before scrolling", () => {
    expect(scrollIntoViewFromSnapshot({ iframes: [] })).toBe(false);
    expect(
      scrollIntoViewFromSnapshot({
        iframes: [
          {
            resource: TURNSTILE_RESOURCE,
            visible: true,
            bounding_box: { x: 10, y: 1200, width: 0, height: 65 },
          },
        ],
      }),
    ).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});

// ─── Schema + executor wiring ───────────────────────────────────────────────

describe("detect_challenge — schema and executor wiring", () => {
  test("scroll_into_view is a strict boolean", () => {
    expect(ActionSchema.safeParse({ type: "detect_challenge" }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: "detect_challenge", scroll_into_view: true }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: "detect_challenge", scroll_into_view: false }).success).toBe(true);
    expect(ActionSchema.safeParse({ type: "detect_challenge", scroll_into_view: "true" }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "detect_challenge", scroll_into_view: 1 }).success).toBe(false);
  });

  test("executeAction returns a success result with the bounded JSON payload", async () => {
    document.body.innerHTML = `
      <div class="cf-turnstile"></div>
      <div class="h-captcha"></div>
    `;
    const result = await executeAction(
      { type: "detect_challenge", scroll_into_view: false },
      makeState(),
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("detect_challenge");
    expect(result.message).toContain("turnstile");
    const parsed = JSON.parse(result.extractedContent ?? "{}");
    expect(parsed.detected).toBe(true);
    expect(parsed.status).toBe("present");
    expect(parsed.matches.map((m: { vendor: string }) => m.vendor).sort()).toEqual([
      "hcaptcha",
      "turnstile",
    ]);
  });

  test("executeAction reports a clean miss as absent", async () => {
    document.body.innerHTML = "<p>nothing here</p>";
    const result = await executeAction(
      { type: "detect_challenge", scroll_into_view: false },
      makeState(),
    );
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.extractedContent ?? "{}");
    expect(parsed).toEqual({ detected: false, status: "absent", matches: [] });
  });
});

describe("runAgentLoop — challenge info-line dedupe is per-run", () => {
  test("a second run hitting the same challenge kind surfaces its info line again", async () => {
    const run = async (): Promise<LogEvent[]> => {
      const events: LogEvent[] = [];
      const deps: LoopDeps = {
        task: "cross the captcha",
        config: {
          maxSteps: 3,
          maxActionsPerStep: 10,
          plannerInterval: 100,
          maxFailures: 5,
          enableLoopDetection: false,
          enableCompaction: false,
          compactionStepInterval: 1000,
          compactionCharThreshold: 1_000_000,
          enableJudge: false,
        },
        navigatorCall: vi.fn(async () => ({
          raw: JSON.stringify({
            thinking: "x",
            evaluation_previous_goal: "y",
            memory: "z",
            next_goal: "w",
            action: [{ type: "click", index: 1 } as AgentAction],
          }),
        })),
        plannerCall: vi.fn(async () => ({
          raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
        })),
        getTabs: vi.fn(async () => [
          { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
        ]),
        extractState: vi.fn(async () => makeState()),
        executeActions: vi.fn(async (actions: AgentAction[]) =>
          actions.map((action) => ({ action, success: true, message: "ok" } as ActionResult)),
        ),
        // An interactive captcha that never clears: the challenge path runs on
        // every step (attempt-first, no takeover), exercising the info-line
        // dedupe across BOTH runs.
        detectChallenge: vi.fn(async () => ({ kind: "recaptcha", message: "reCAPTCHA challenge" })),
        onEvent: (e: LogEvent) => { events.push(e); },
        settleDelay: 0,
      };
      await runAgentLoop(deps);
      return events;
    };

    const infoLines = (events: LogEvent[]) =>
      events.filter((e) => e.type === "info" && String(e.message).startsWith("Anti-bot challenge detected"));

    const first = await run();
    const second = await run();

    // Run 1 surfaces the info line (per-step dedupe suppresses it on later
    // steps of the SAME run — at least one occurrence is the contract).
    expect(infoLines(first).length).toBeGreaterThanOrEqual(1);
    // Finding 6: `lastChallengeKey` survived across runs, so run 2's info
    // line was suppressed. A fresh run must re-arm the dedupe and surface it.
    expect(infoLines(second).length).toBeGreaterThanOrEqual(1);
  });
});
