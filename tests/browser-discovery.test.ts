import { describe, expect, it } from "vitest";

import { constants } from "node:fs";

import { chromeExecutableSearchPaths, findChromeExecutable, findChromiumExecutables, isExecutableReady } from "@/server/browser/discovery";

type FakeEntry = { kind: "file" | "directory"; mode?: number; accessible?: boolean };

function fileSystemWith(...paths: string[]): {
  statSync(path: string): { isFile(): boolean; mode: number };
  accessSync(path: string, mode?: number): void;
} {
  const entries = new Map(paths.map((path) => [path, { kind: "file" as const, mode: 0o755, accessible: true }]));
  return fileSystemWithEntries(entries);
}

function fileSystemWithEntries(entries: Map<string, FakeEntry>): {
  statSync(path: string): { isFile(): boolean; mode: number };
  accessSync(path: string, mode?: number): void;
} {
  return {
    statSync: (path) => {
      const entry = entries.get(path);
      if (!entry) {
        throw new Error("missing");
      }
      return { isFile: () => entry.kind === "file", mode: entry.mode ?? 0 };
    },
    accessSync: (path, mode) => {
      const entry = entries.get(path);
      if (!entry || entry.accessible === false || mode !== constants.X_OK) {
        throw new Error("not accessible");
      }
    },
  };
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

  it("accepts only regular POSIX files with execute permission and access", () => {
    const executable = searchPath(/Google Chrome\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome$/);
    const directory = searchPath(/Google Chrome Beta\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome Beta$/);
    const nonExecutable = searchPath(/Google Chrome Dev\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome Dev$/);
    const inaccessible = searchPath(/Google Chrome Canary\.app[\\/]Contents[\\/]MacOS[\\/]Google Chrome Canary$/);
    const entries = new Map<string, FakeEntry>([
      [executable, { kind: "file", mode: 0o755, accessible: true }],
      [directory, { kind: "directory", mode: 0o755, accessible: true }],
      [nonExecutable, { kind: "file", mode: 0o644, accessible: true }],
      [inaccessible, { kind: "file", mode: 0o755, accessible: false }],
    ]);
    const fs = fileSystemWithEntries(entries);

    expect(isExecutableReady(executable, fs, "darwin")).toBe(true);
    expect(isExecutableReady(directory, fs, "darwin")).toBe(false);
    expect(isExecutableReady(nonExecutable, fs, "darwin")).toBe(false);
    expect(isExecutableReady(inaccessible, fs, "darwin")).toBe(false);
    expect(findChromeExecutable(fs)).toEqual({ path: executable, channel: "stable", label: "Google Chrome" });
  });

  it("uses regular-file semantics on Windows without requiring POSIX access", () => {
    const executable = searchPath(/[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
    const directory = searchPath(/[\\/]Google[\\/]Chrome Beta[\\/]Application[\\/]chrome\.exe$/);
    const entries = new Map<string, FakeEntry>([
      [executable, { kind: "file", mode: 0o644, accessible: false }],
      [directory, { kind: "directory", mode: 0o755, accessible: true }],
    ]);
    const fs = fileSystemWithEntries(entries);

    expect(isExecutableReady(executable, fs, "win32")).toBe(true);
    expect(isExecutableReady(directory, fs, "win32")).toBe(false);
  });

  it("filters non-regular and non-executable candidates from the Chromium inventory", () => {
    const brave = searchPath(/Brave Browser\.app[\\/]Contents[\\/]MacOS[\\/]Brave Browser$/);
    const edge = searchPath(/Microsoft Edge\.app[\\/]Contents[\\/]MacOS[\\/]Microsoft Edge$/);
    const entries = new Map<string, FakeEntry>([
      [brave, { kind: "directory", mode: 0o755, accessible: true }],
      [edge, { kind: "file", mode: 0o644, accessible: true }],
    ]);

    expect(findChromiumExecutables(fileSystemWithEntries(entries))).toEqual([]);
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
