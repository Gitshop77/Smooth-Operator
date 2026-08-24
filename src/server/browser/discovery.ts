import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { env } from "node:process";

export type ChromeChannel = "stable" | "beta" | "dev" | "canary";

export interface ChromeExecutable {
  path: string;
  channel: ChromeChannel;
  /** Human-readable browser name, e.g. "Google Chrome" or "Brave". */
  label: string;
}

interface FileSystem {
  existsSync(path: string): boolean;
}

interface ChromeExecutableCandidate extends ChromeExecutable {}

/** Every Chromium-based browser the server can drive, in preference order:
 * Google Chrome channels first (widest compatibility), then other installed
 * Chromium browsers. Any CDP-compatible executable can also be set manually
 * via SMOOTH_OPERATOR_BROWSER_EXECUTABLE or browser.executablePath config. */
export function findChromeExecutable(fs: FileSystem = nodeFs): ChromeExecutable | null {
  return chromeExecutableCandidates().find((candidate) => fs.existsSync(candidate.path)) ?? null;
}

/** All installed Chromium-based browsers found on this machine. */
export function findChromiumExecutables(fs: FileSystem = nodeFs): ChromeExecutable[] {
  return chromeExecutableCandidates().filter((candidate) => fs.existsSync(candidate.path));
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
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome", "Google Chrome", "Google Chrome", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome Beta", "Google Chrome Beta", "Google Chrome Beta", "beta"),
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome Dev", "Google Chrome Dev", "Google Chrome Dev", "dev"),
    ...applicationBundleCandidates(applicationDirectories, "Google Chrome Canary", "Google Chrome Canary", "Google Chrome Canary", "canary"),
    ...applicationBundleCandidates(applicationDirectories, "Brave Browser", "Brave Browser", "Brave", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Microsoft Edge", "Microsoft Edge", "Microsoft Edge", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Chromium", "Chromium", "Chromium", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Vivaldi", "Vivaldi", "Vivaldi", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Arc", "Arc", "Arc", "stable"),
    ...applicationBundleCandidates(applicationDirectories, "Opera", "Opera", "Opera", "stable"),
  ];
}

function applicationBundleCandidates(
  applicationDirectories: readonly string[],
  bundleName: string,
  executableName: string,
  label: string,
  channel: ChromeChannel,
): ChromeExecutableCandidate[] {
  return applicationDirectories.map((applicationDirectory) => ({
    path: join(applicationDirectory, `${bundleName}.app`, "Contents", "MacOS", executableName),
    channel,
    label,
  }));
}

function windowsCandidates(): ChromeExecutableCandidate[] {
  const directories = [
    env.PROGRAMFILES ?? "C:\\Program Files",
    env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
    env.LOCALAPPDATA,
  ].filter((directory): directory is string => Boolean(directory));
  return [
    ...windowsChannelCandidates(directories, ["Google", "Chrome"], "chrome.exe", "Google Chrome", "stable"),
    ...windowsChannelCandidates(directories, ["Google", "Chrome Beta"], "chrome.exe", "Google Chrome Beta", "beta"),
    ...windowsChannelCandidates(directories, ["Google", "Chrome Dev"], "chrome.exe", "Google Chrome Dev", "dev"),
    ...windowsChannelCandidates(directories, ["Google", "Chrome SxS"], "chrome.exe", "Google Chrome Canary", "canary"),
    ...windowsChannelCandidates(directories, ["BraveSoftware", "Brave-Browser"], "brave.exe", "Brave", "stable"),
    ...windowsChannelCandidates(directories, ["Microsoft", "Edge"], "msedge.exe", "Microsoft Edge", "stable"),
    ...windowsChannelCandidates(directories, ["Chromium"], "chrome.exe", "Chromium", "stable"),
    ...windowsChannelCandidates(directories, ["Vivaldi"], "vivaldi.exe", "Vivaldi", "stable"),
  ];
}

function windowsChannelCandidates(directories: readonly string[], directoryParts: readonly string[], executable: string, label: string, channel: ChromeChannel): ChromeExecutableCandidate[] {
  return directories.map((baseDirectory) => ({
    path: win32.join(baseDirectory, ...directoryParts, "Application", executable),
    channel,
    label,
  }));
}

function linuxCandidates(): ChromeExecutableCandidate[] {
  const searchDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const commands: readonly [string, string, ChromeChannel][] = [
    ["google-chrome", "Google Chrome", "stable"],
    ["google-chrome-stable", "Google Chrome", "stable"],
    ["google-chrome-beta", "Google Chrome Beta", "beta"],
    ["google-chrome-unstable", "Google Chrome Dev", "dev"],
    ["brave-browser", "Brave", "stable"],
    ["brave", "Brave", "stable"],
    ["microsoft-edge", "Microsoft Edge", "stable"],
    ["microsoft-edge-stable", "Microsoft Edge", "stable"],
    ["chromium", "Chromium", "stable"],
    ["chromium-browser", "Chromium", "stable"],
    ["vivaldi", "Vivaldi", "stable"],
    ["vivaldi-stable", "Vivaldi", "stable"],
  ];
  return commands.flatMap(([command, label, channel]) => searchDirectories.map((directory) => ({ path: join(directory, command), channel, label })));
}
