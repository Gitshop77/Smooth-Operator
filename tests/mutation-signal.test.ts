import { describe, it, expect } from "vitest";
import { bumpDomEpoch, getDomEpoch, installMutationSignal } from "../src/lib/agent/dom/mutation-signal";

describe("mutation-signal", () => {
  it("bumps the epoch when the DOM mutates", async () => {
    installMutationSignal(); // no-op if already installed
    const before = getDomEpoch();
    const el = document.createElement("div");
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 10));
    expect(getDomEpoch()).toBeGreaterThan(before);
  });

  it("does not bump on reads", () => {
    const before = getDomEpoch();
    document.body.getBoundingClientRect();
    expect(getDomEpoch()).toBe(before);
  });

  it("bumpDomEpoch increments the epoch explicitly", () => {
    const before = getDomEpoch();
    bumpDomEpoch();
    expect(getDomEpoch()).toBe(before + 1);
  });
});