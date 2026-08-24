import { describe, expect, it } from "vitest";

import { findChromeExecutable } from "@/server/browser/discovery";

function fileSystemWith(...paths: string[]): { existsSync(path: string): boolean } {
  const available = new Set(paths);
  return { existsSync: (path) => available.has(path) };
}

describe("Chrome executable discovery", () => {
  it("prefers the macOS stable channel", () => {
    const path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    expect(findChromeExecutable(fileSystemWith(path))).toEqual({ path, channel: "stable" });
  });

  it("finds Windows channel installs in their documented order", () => {
    const beta = "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe";
    const canary = "C:\\Users\\example\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe";

    expect(findChromeExecutable(fileSystemWith(beta))).toEqual({ path: beta, channel: "beta" });
    expect(findChromeExecutable(fileSystemWith(beta, canary))).toEqual({ path: beta, channel: "beta" });
  });

  it("resolves Linux browser names through PATH", () => {
    const chromium = "/usr/local/bin/chromium";

    expect(findChromeExecutable(fileSystemWith(chromium))).toEqual({ path: chromium, channel: "stable" });
  });

  it("returns null when none of the supported candidates exists", () => {
    expect(findChromeExecutable(fileSystemWith())).toBeNull();
  });
});
