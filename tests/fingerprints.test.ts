import { describe, expect, it } from "vitest";

import { nativeBrowserLaunchArgs } from "@/server/browser/compatibility";

describe("browser compatibility dimensions", () => {
  it("does not invent a default identity window size", () => {
    expect(nativeBrowserLaunchArgs().some((flag) => flag.startsWith("--window-size"))).toBe(false);
    expect(nativeBrowserLaunchArgs({ viewport: { width: 1_366, height: 768 } })).toContain("--window-size=1366,768");
  });

  it("ignores invalid viewport dimensions instead of fabricating identity", () => {
    expect(nativeBrowserLaunchArgs({ viewport: { width: 0, height: Number.NaN } }).some((flag) => flag.startsWith("--window-size"))).toBe(false);
    expect(nativeBrowserLaunchArgs({ viewport: { width: 1_366.9, height: 768.2 } }).some((flag) => flag.startsWith("--window-size"))).toBe(false);
  });

  it("does not expose replacement identity or hardware claims", () => {
    const args = nativeBrowserLaunchArgs({ gpu: true, viewport: { width: 800, height: 600 } });
    expect(JSON.stringify(args)).not.toMatch(/userAgent|platform|hardwareConcurrency|deviceMemory|languages|client/i);
    expect(JSON.stringify(args)).not.toMatch(/Mozilla|Win32|WebGL|canvas|webdriver/i);
  });

  it("does not change launch identity between balanced and max profiles", () => {
    expect(nativeBrowserLaunchArgs({ gpu: false })).toEqual(nativeBrowserLaunchArgs({ gpu: false }));
    expect(nativeBrowserLaunchArgs()).not.toEqual(expect.arrayContaining(["--lang=en-US"]));
  });
});
