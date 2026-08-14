/**
 * Dirty-subtree re-walk tests (task B2).
 *
 * `mutation-signal.ts` records the TOPMOST mutated subtrees per DOM epoch
 * (exposed via `dirty-subtrees.ts`'s `getDirtyRoots`/`clearDirtyRoots`).
 * `extractBrowserState` consumes them on the next extraction to re-serialize
 * ONLY the dirty subtrees and splice the results into the previous walk's
 * elements/lines arrays — non-dirty regions keep their cached serialization
 * byte-for-byte (and their element indices).
 *
 * Fallbacks (fail-closed):
 *  - epoch changed but NO dirty roots recorded (explicit bump / observer gap)
 *    → full walk;
 *  - more than 50% of the previous walk's elements are inside dirty subtrees
 *    (splice cost exceeds a full rebuild) → full walk.
 *
 * The "did a partial re-walk actually happen" marker is
 * `ReadCache.prototype.batchRead` — every element visit in a walk calls it,
 * and a partial re-walk only visits the dirty subtree's elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBrowserState, resetDomBaseline } from "../src/lib/agent/dom/extraction/page-state";
import { ReadCache } from "../src/lib/agent/dom/utils/read-cache";
import {
  clearDirtyRoots,
  getDirtyRoots,
} from "../src/lib/agent/dom/dirty-subtrees";
import {
  bumpDomEpoch,
  getDomEpoch,
  installMutationSignal,
} from "../src/lib/agent/dom/mutation-signal";
import {
  installJsdomLayoutMock,
  restoreJsdomLayoutMock,
} from "./helpers";

const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * Flush + consume the mutation records caused by the test's own DOM setup
 * (`innerHTML` assignment etc. — delivered in a microtask, they would mark
 * `body` dirty and force the full-walk fallback in the next extract). Call
 * after the baseline extract and before applying the mutation under test.
 */
async function settleDom(): Promise<void> {
  await tick();
  clearDirtyRoots(getDomEpoch());
}

beforeEach(() => {
  document.body.innerHTML = "";
  resetDomBaseline();
  installJsdomLayoutMock();
  installMutationSignal();
  clearDirtyRoots(getDomEpoch());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  installMutationSignal();
  restoreJsdomLayoutMock();
});

describe("dirty-root recording (mutation-signal)", () => {
  it("(a) mutating one subtree yields exactly one dirty root", async () => {
    const region = document.createElement("div");
    region.id = "region";
    document.body.appendChild(region);
    await tick();
    clearDirtyRoots(getDomEpoch());

    region.appendChild(document.createElement("span"));
    await tick();

    const roots = getDirtyRoots(getDomEpoch());
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(region);
    clearDirtyRoots(getDomEpoch());
  });

  it("(b) mutating a child inside a mutated parent yields only the parent root", async () => {
    const parent = document.createElement("div");
    parent.id = "outer";
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);
    await tick();
    clearDirtyRoots(getDomEpoch());

    // Mutate the parent itself, then its child — only the parent root remains.
    parent.setAttribute("data-x", "1");
    child.textContent = "x";
    await tick();

    const roots = getDirtyRoots(getDomEpoch());
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(parent);
    clearDirtyRoots(getDomEpoch());
  });

  it("mutations in two separate subtrees yield two dirty roots", async () => {
    const left = document.createElement("div");
    const right = document.createElement("div");
    left.id = "left";
    right.id = "right";
    document.body.appendChild(left);
    document.body.appendChild(right);
    await tick();
    clearDirtyRoots(getDomEpoch());

    left.setAttribute("data-a", "1");
    right.setAttribute("data-b", "2");
    await tick();

    const roots = getDirtyRoots(getDomEpoch());
    expect(roots).toHaveLength(2);
    expect(roots).toContain(left);
    expect(roots).toContain(right);
    clearDirtyRoots(getDomEpoch());
  });
});

describe("partial re-walk (dirty-subtree splice)", () => {
  it("(c) re-walks only the dirty subtree; new text lands, untouched bytes are unchanged", async () => {
    document.body.innerHTML =
      '<button id="b1">One</button><div id="mid"><span id="mut">Old text</span></div><button id="b2">Two</button>';
    const first = extractBrowserState([]);
    expect(first.elementsText).toContain("Old text");
    const firstLines = first.elementsText.split("\n");
    await settleDom();

    // Text mutation inside span#mut — the dirty root is the span itself.
    document.getElementById("mut")!.textContent = "New text";
    await tick();

    const batchSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = extractBrowserState([]);

    // Only the span's subtree was re-walked (one element visit).
    expect(batchSpy).toHaveBeenCalledTimes(1);
    // The changed text is present, the old one gone.
    expect(second.elementsText).toContain("New text");
    expect(second.elementsText).not.toContain("Old text");
    // Untouched regions are byte-identical (substring equality against the
    // previous serialization) and keep their element indices.
    const secondLines = second.elementsText.split("\n");
    expect(secondLines[0]).toBe(firstLines[0]);
    expect(secondLines[1]).toBe(firstLines[1]);
    expect(second.elements.map((e) => e.index)).toEqual([1, 2]);
    expect(second.elements.map((e) => e.tag)).toEqual(["button", "button"]);
  });

  it("preserves indices and cached bytes of untouched regions when a dirty subtree loses an element", async () => {
    document.body.innerHTML =
      '<div id="left"><button id="a">A</button></div><div id="right"><button id="b">B</button></div>';
    const first = extractBrowserState([]);
    expect(first.elements.map((e) => e.index)).toEqual([1, 2]);
    await settleDom();

    // Remove button #a — the dirty root is div#left (1 of 2 elements → 50%,
    // not more than half → partial re-walk).
    document.getElementById("a")!.remove();
    await tick();

    const second = extractBrowserState([]);
    // Button #b is untouched: it keeps its previous index 2 (a full re-walk
    // would have re-sequenced it to 1).
    expect(second.elements.map((e) => e.index)).toEqual([2]);
    expect(second.elementsText).toContain('[2]<button id="b"');
    expect(second.elementsText).not.toContain("[1]<button");
  });

  it("supports repeated partial re-walks targeting previously spliced subtrees", async () => {
    document.body.innerHTML =
      '<div id="l"><button id="a">A</button></div><div id="r"><button id="b">B</button></div>';
    extractBrowserState([]);
    await settleDom();

    document.getElementById("a")!.textContent = "A2";
    await tick();
    const second = extractBrowserState([]);
    expect(second.elementsText).toContain("A2");

    // A later mutation in the OTHER subtree is still a partial re-walk.
    document.getElementById("b")!.textContent = "B2";
    await tick();
    const batchSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const third = extractBrowserState([]);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(third.elementsText).toContain("B2");
    expect(third.elements.map((e) => e.index)).toEqual([1, 2]);
  });

  it("falls back to a full walk when more than half of the elements are dirty", async () => {
    document.body.innerHTML =
      "<div id='wrap'>" + "<button>B</button>".repeat(6) + "</div><button id='out'>O</button>";
    const first = extractBrowserState([]);
    expect(first.elements).toHaveLength(7);
    await settleDom();

    // childList mutation on the wrap — its subtree holds 6 of 7 elements
    // (>50%) → the splice would cost more than a full rebuild.
    document.getElementById("wrap")!.appendChild(document.createTextNode("more"));
    await tick();

    const batchSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = extractBrowserState([]);
    // Full walk: every element visited (wrap + 6 buttons + outer button).
    expect(batchSpy).toHaveBeenCalledTimes(8);
    expect(second.elementsText).toContain("more");
    expect(second.elements).toHaveLength(7);
  });

  it("falls back to a full walk when the epoch changed but no dirty roots were recorded (observer gap)", async () => {
    document.body.innerHTML =
      '<button id="b1">One</button><div id="mid"><span>mid</span></div><button id="b2">Two</button>';
    extractBrowserState([]);
    await settleDom();

    // An explicit epoch bump without mutation records (what an observer gap
    // or `resetDomBaseline` looks like) — the dirty-root set is empty.
    bumpDomEpoch();
    const batchSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = extractBrowserState([]);
    expect(batchSpy).toHaveBeenCalledTimes(4);
    expect(second.elementsText).toContain("Two");
  });

  it("a partial re-walk keeps newElementCount/*-markers consistent with hashes", async () => {
    document.body.innerHTML =
      '<div id="l"><button id="a">Alpha</button></div><div id="r"><button id="b">Bravo</button></div>';
    const first = extractBrowserState([]);
    expect(first.newElementCount).toBe(2);
    expect(first.elementsText).toContain("*[1]<button");
    expect(first.elementsText).toContain("*[2]<button");
    await settleDom();

    // Add a NEW button to the left subtree (1 of 2 elements dirty → 50%).
    const fresh = document.createElement("button");
    fresh.textContent = "Charlie";
    document.getElementById("l")!.appendChild(fresh);
    await tick();

    const second = extractBrowserState([]);
    // The new button is the only new element, marked * at its appended index;
    // the re-serialized #a keeps its index without a stale *; the untouched
    // #b line is byte-identical to the previous walk's.
    expect(second.newElementCount).toBe(1);
    expect(second.elementsText).toContain("*[3]<button role=\"button\" />");
    expect(second.elementsText).toContain("\t\t[1]<button id=\"a\" role=\"button\" />");
    expect(second.elementsText).not.toContain("*[1]<button");
    expect(second.elementsText).toContain(first.elementsText.split("\n")[1]);
  });
});