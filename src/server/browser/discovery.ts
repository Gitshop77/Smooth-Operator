import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { env } from "node:process";

export type ChromeChannel = "stable" | "beta" | "dev" | "canary";

export interface ChromeExecutable {
  path: string;
  channel: ChromeChannel;
}

interface FileSystem {
  existsSync(path: string): boolean;
}

interface ChromeExecutableCandidate extends ChromeExecutable {}

export function findChromeExecutable(fs: FileSystem = nodeFs): ChromeExecutable | null {
  return chromeExecutableCandidates().find((candidate) => fs.existsSync(candidate.path)) ?? null;
}

export function chromeExecutableSearchPaths(): string[] {
  return chromeExecutableCandidates().map((candidate) => candidate.path);
}

function chromeExecutableCandidates(): ChromeExecutableCandidate[] {
  return [
    ...macOsCandidates(),
    ...windowsCandidates(),
    ...linuxCandidates(),
  ];
}

function macOsCandidates(): ChromeExecutableCandidate[] {
  const applicationDirectories = ["/Applications", join(homedir(), "Applications")];
  return [
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome", "Google Chrome", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome Beta", "Google Chrome Beta", "beta"),
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome Dev", "Google Chrome Dev", "dev"),
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome Canary", "Google Chrome Canary", "canary"),
  ];
}

function applicationBundleCandidates(
  applicationDirectories: readonly string[],
  bundleName: string,
  executableName: string,
  channel: ChromeChannel,
): ChromeExecutableCandidate[] {
  return applicationDirectories.map((applicationDirectory) => ({
    path: join(applicationDirectory, `${bundleName}.app`, "Contents", "MacOS", executableName),
    channel,
  }));
}

function windowsCandidates(): ChromeExecutableCandidate[] {
  const directories = [
    env.PROGRAMFILES ?? "C:\\Program Files",
    env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    env.LOCALAPPDATA,
  ].filter((directory): directory is string => Boolean(directory));
  return [
    ...windowsChannelCandidates(directories, "Chrome", "stable"),
    ...windowsChannelCandidates(directories, "Chrome Beta", "beta"),
    ...windowsChannelCandidates(directories, "Chrome Dev", "dev"),
    ...windowsChannelCandidates(directories, "Chrome SxS", "canary"),
  ];
}

function windowsChannelCandidates(directories: readonly string[], directory: string, channel: ChromeChannel): ChromeExecutableCandidate[] {
  return directories.map((baseDirectory) => ({
    path: win32.join(baseDirectory, "Google", directory, "Application", "chrome.exe"),
    channel,
  }));
}

function linuxCandidates(): ChromeExecutableCandidate[] {
  const searchDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const commands: readonly [string, ChromeChannel][] = [
    ["google-chrome", "stable"],
    ["google-chrome-stable", "stable"],
    ["google-chrome-beta", "beta"],
    ["google-chrome-unstable", "dev"],
    ["chromium", "stable"],
    ["chromium-browser", "stable"],
  ];
  return commands.flatMap(([command, channel]) => searchDirectories.map((directory) => ({ path: join(directory, command), channel })));
}
