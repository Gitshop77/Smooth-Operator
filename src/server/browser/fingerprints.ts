/**
 * Deterministic, coherent browser fingerprint values shared by the stealth
 * baseline. This module computes VALUES only (UA + Client Hints brands +
 * viewport + language); it does not build init-script source and never touches
 * the browser runtime. Every value is a pure function of the supplied options,
 * so the same options always yield the same profile.
 */

export type StealthProfile = "balanced" | "max";
export type Platform = "Windows" | "macOS" | "Linux";

export interface Brand {
  brand: string;
  version: string;
}

export interface FingerprintProfile {
  version: number; // Chrome major version
  userAgent: string; // coherent desktop Chrome UA (no HeadlessChrome)
  platform: Platform;
  mobile: false;
  brands: Brand[]; // derivable from `version`
  fullVersionList: Record<string, string>; // { Chromium, Google Chrome }
  languages: string[]; // ["en-US", "en"]
  acceptLanguage: string; // "en-US,en;q=0.9"
  viewport: { width: number; height: number };
  // `max` only:
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
  timeZone?: string;
}

export interface BuildOptions {
  profile?: StealthProfile; // default "balanced"
  seed?: number; // reserved for per-session jitter; core values are pure
  version?: number; // default 124 (stable recent Chrome)
  platform?: Platform; // default "Windows"
  viewport?: { width: number; height: number }; // default { 1920, 1080 }
  language?: string; // default "en-US"
  timeZone?: string; // default "America/New_York"
}

const DEFAULT_PROFILE: StealthProfile = "balanced";
const DEFAULT_VERSION = 124;
const DEFAULT_PLATFORM: Platform = "Windows";
const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;
const DEFAULT_SEED = 0;

// Desktop platform segments kept in the UA so the claim matches the platform.
const PLATFORM_SEGMENTS: Record<Platform, string> = {
  Windows: "Windows NT 10.0; Win64; x64",
  macOS: "Mac OS X 10_15_7",
  Linux: "X11; Linux x86_64",
};

// Valid hardware surfaces (Castle valid-sets). `max` picks one per field.
const HARDWARE_CONCURRENCY_SET = [2, 4, 8, 16, 32];
const DEVICEMEMORY_SET = [1, 2, 4, 8];
const MAX_TOUCH_POINTS_SET = [0, 5, 10];

export function buildFingerprintProfile(options: BuildOptions = {}): FingerprintProfile {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const version = normalizeVersion(options.version);
  const platform = normalizePlatform(options.platform);
  const viewport = normalizeViewport(options.viewport);
  const language = options.language ?? DEFAULT_LANGUAGE;
  const seed = normalizeSeed(options.seed);

  const versionStr = String(version);

  const userAgent = `Mozilla/5.0 (${PLATFORM_SEGMENTS[platform]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionStr}.0.0.0 Safari/537.36`;

  const brands: Brand[] = [
    { brand: "Chromium", version: versionStr },
    { brand: "Google Chrome", version: versionStr },
    { brand: "Not=A?Brand", version: "8" },
  ];

  const fullVersionList: Record<string, string> = {
    Chromium: versionStr,
    "Google Chrome": versionStr,
  };

  const profileWithLanguages = {
    version,
    userAgent,
    platform,
    mobile: false as const,
    brands,
    fullVersionList,
    languages: buildLanguages(language),
    acceptLanguage: `${language},en;q=0.9`,
    viewport,
  };

  if (profile === "max") {
    return {
      ...profileWithLanguages,
      hardwareConcurrency: pickFromValidSet(HARDWARE_CONCURRENCY_SET, seed),
      deviceMemory: pickFromValidSet(DEVICEMEMORY_SET, seed),
      maxTouchPoints: pickFromValidSet(MAX_TOUCH_POINTS_SET, seed),
      timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    };
  }

  return profileWithLanguages;
}

function normalizeVersion(version: number | undefined): number {
  return typeof version === "number" && Number.isFinite(version) && version > 0 ? Math.floor(version) : DEFAULT_VERSION;
}

function normalizePlatform(platform: Platform | undefined): Platform {
  return platform && platform in PLATFORM_SEGMENTS ? platform : DEFAULT_PLATFORM;
}

function normalizeViewport(viewport: { width: number; height: number } | undefined): { width: number; height: number } {
  if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0) {
    return { width: Math.floor(viewport.width), height: Math.floor(viewport.height) };
  }
  return { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
}

function normalizeSeed(seed: number | undefined): number {
  return typeof seed === "number" && Number.isFinite(seed) ? seed : DEFAULT_SEED;
}

// `en-US` -> ["en-US", "en"]; a bare language -> ["en"].
function buildLanguages(language: string): string[] {
  const parts = language.split(/[-_]/);
  return parts.length > 1 ? [language, parts[0].toLowerCase()] : [language];
}

function pickFromValidSet(set: readonly number[], seed: number): number {
  return set[Math.floor(Math.abs(seed)) % set.length];
}
