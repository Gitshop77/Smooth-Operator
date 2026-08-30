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
  statSync(path: string): Pick<nodeFs.Stats, "isFile" | "mode">;
  accessSync(path: string, mode?: number): void;
}

interface ChromeExecutableCandidate extends ChromeExecutable {}

/** Every Chromium-based browser the server can drive, in preference order:
 * Google Chrome channels first (widest compatibility), then other installed
 * Chromium browsers. Any CDP-compatible executable can also be set manually
 * via SMOOTH_OPERATOR_BROWSER_EXECUTABLE or browser.executablePath config. */
export function findChromeExecutable(fs: FileSystem = nodeFs): ChromeExecutable | null {
  // Candidate generation is cheap, but duplicate PATH entries and platform
  // aliases are common. Deduping before touching the filesystem keeps startup
  // discovery deterministic and avoids redundant readiness checks.
  return dedupeCandidates(chromeExecutableCandidates()).find((candidate) => isExecutableReady(candidate.path, fs)) ?? null;
}

/** All installed Chromium-based browsers found on this machine. */
export function findChromiumExecutables(fs: FileSystem = nodeFs): ChromeExecutable[] {
  return dedupeCandidates(chromeExecutableCandidates()).filter((candidate) => isExecutableReady(candidate.path, fs));
}

/**
 * Return whether a candidate is a usable browser executable.
 *
 * This helper deliberately returns only a boolean so callers such as
 * browser_doctor can report readiness without echoing paths or filesystem
 * errors. The filesystem and platform arguments are injectable for deterministic
 * tests; production callers use the native filesystem and current platform.
 */
export function isExecutableReady(
  path: string,
  fs: FileSystem = nodeFs,
  platformName: NodeJS.Platform = process.platform,
): boolean {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }

  try {
    const stats = fs.statSync(path);
    if (!stats.isFile()) {
      return false;
    }

    // Windows does not expose POSIX execute bits. A regular file is the
    // strongest portable readiness check available there; CreateProcess will
    // provide the final format/permission validation at launch time.
    if (platformName === "win32") {
      return true;
    }

    // Check both mode bits and effective access. The mode check prevents a
    // privileged process from accepting a file that is not marked executable.
    if ((stats.mode & 0o111) === 0) {
      return false;
    }
    fs.accessSync(path, nodeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function chromeExecutableSearchPaths(): string[] {
  return dedupeCandidates(chromeExecutableCandidates()).map((candidate) => candidate.path);
}

function dedupeCandidates(candidates: readonly ChromeExecutableCandidate[]): ChromeExecutableCandidate[] {
  const seen = new Set<string>();
  const unique: ChromeExecutableCandidate[] = [];
  for (const candidate of candidates) {
    // Windows paths are case-insensitive. Lower-casing only for the key keeps
    // the original spelling available to callers while avoiding duplicate
    // probes when PATH or environment variables repeat an entry.
    const key = process.platform === "win32" ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
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
