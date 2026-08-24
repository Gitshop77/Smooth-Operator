import { describe, expect, it } from "vitest";

import { chromeExecutableSearchPaths, findChromeExecutable } from "@/server/browser/discovery";

function fileSystemWith(...paths: string[]): { existsSync(path: string): boolean } {
  const available = new Set(paths);
  return { existsSync: (path) => available.has(path) };
}

function searchPath(pattern: RegExp): string {
  const path = chromeExecutableSearchPaths().find((candidate) => pattern.test(candidate));
  if (!path) {
    throw new Error(`No browser candidate matched ${pattern}.`);
  }
  return path;
}

describe("Chrome executable discovery", () => {
  it("prefers the macOS stable channel", () => {
    const path = searchPath(/Google Chrome\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome$/);

    expect(findChromeExecutable(fileSystemWith(path))).toEqual({ path, channel: "stable", label: "Google Chrome" });
  });

  it("finds Windows channel installs in their documented order", () => {
    const beta = searchPath(/[\\/]Google[\\/]Chrome Beta[\\/]Application[\\/]chrome\.exe$/);
    const canary = searchPath(/[\\/]Google[\\/]Chrome SxS[\\/]Application[\\/]chrome\.exe$/);

    expect(findChromeExecutable(fileSystemWith(beta))).toEqual({ path: beta, channel: "beta", label: "Google Chrome Beta" });
    expect(findChromeExecutable(fileSystemWith(beta, canary))).toEqual({ path: beta, channel: "beta", label: "Google Chrome Beta" });
  });

  it("resolves Linux browser names through PATH", () => {
    const chromium = searchPath(/[\\/]chromium$/);

    expect(findChromeExecutable(fileSystemWith(chromium))).toEqual({ path: chromium, channel: "stable", label: "Chromium" });
  });

  it("returns null when none of the supported candidates exists", () => {
    expect(findChromeExecutable(fileSystemWith())).toBeNull();
  });
});

describe("Chromium-based browser discovery", () => {
  it("detects Brave on macOS", () => {
    const brave = searchPath(/Brave Browser\.app[\\/]Contents[\\/]MacOS[\\/]Brave Browser$/);

    expect(findChromeExecutable(fileSystemWith(brave))).toEqual({ path: brave, channel: "stable", label: "Brave" });
  });

  it("lists every installed Chromium-based browser in preference order", () => {
    const chrome = searchPath(/Google Chrome\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome$/);
    const brave = searchPath(/Brave Browser\.app[\\/]Contents[\\/]MacOS[\\/]Brave Browser$/);
    const edge = searchPath(/Microsoft Edge\.app[\\/]Contents[\\/]MacOS[\\/]Microsoft Edge$/);

    expect(findChromeExecutable(fileSystemWith(brave))).toEqual({ path: brave, channel: "stable", label: "Brave" });
    expect(findChromeExecutable(fileSystemWith(brave, edge))?.label).toBe("Brave");
    expect(chromeExecutableSearchPaths().indexOf(brave)).toBeGreaterThan(chromeExecutableSearchPaths().indexOf(chrome));
  });
});
