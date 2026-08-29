import { describe, expect, it } from "vitest";

import { buildFingerprintProfile } from "@/server/browser/fingerprints";
import { NATIVE_BROWSER_LAUNCH_ARGS, nativeBrowserLaunchArgs } from "@/server/browser/compatibility";
import { buildStealthInitScript, STEALTH_BASELINE_ARGS } from "@/server/browser/stealth";

// `new Function` compiles the source without running it, so a throw here is a
// pure syntax error — proving the init script is well-formed page-JS.
function compiles(source: string) {
  expect(() => new Function(source)).not.toThrow();
}

const MARKERS = ["webdriver", "permissions"];

describe("nativeBrowserLaunchArgs — stealth baseline", () => {
  it("appends the stealth baseline flags when enabled", () => {
    const result = nativeBrowserLaunchArgs({ enabled: true });
    for (const flag of STEALTH_BASELINE_ARGS) {
      expect(result).toContain(flag);
    }
  });

  it("omits stealth flags when disabled", () => {
    const result = nativeBrowserLaunchArgs();
    expect(result).not.toContain("--disable-blink-features=AutomationControlled");
    expect(result).not.toContain("--lang=en-US");
    expect(result).not.toContain("--window-size=1920,1080");
  });

  it("returns a fresh array without mutating the shared baseline", () => {
    const baselineBefore = [...STEALTH_BASELINE_ARGS];
    const nativeBefore = [...NATIVE_BROWSER_LAUNCH_ARGS];
    const returned = nativeBrowserLaunchArgs({ enabled: true, gpu: true });
    expect(returned).not.toBe(STEALTH_BASELINE_ARGS);
    expect(returned).not.toBe(NATIVE_BROWSER_LAUNCH_ARGS);
    // Mutating the returned array must not affect the shared baseline or the
    // native defaults.
    const mutable = [...returned];
    mutable.push("--test-only");
    expect([...STEALTH_BASELINE_ARGS]).toEqual(baselineBefore);
    expect([...NATIVE_BROWSER_LAUNCH_ARGS]).toEqual(nativeBefore);
    expect([...returned]).not.toContain("--test-only");
  });

  it("appends GPU flags only when gpu is true", () => {
    const withoutGpu = nativeBrowserLaunchArgs({ enabled: true });
    const withGpu = nativeBrowserLaunchArgs({ enabled: true, gpu: true });
    expect(withoutGpu).not.toContain("--use-angle=vulkan");
    expect(withoutGpu).not.toContain("--enable-vulkan");
    expect(withGpu).toContain("--use-angle=vulkan");
    expect(withGpu).toContain("--enable-vulkan");
    expect(withGpu.length).toBe(withoutGpu.length + 2);
  });

  it("produces a clean, deduped set with only explicit viewport claims", () => {
    const result = nativeBrowserLaunchArgs({ enabled: true, gpu: true });
    expect(result.filter((arg) => arg.startsWith("--lang"))).toHaveLength(0);
    expect(result.filter((arg) => arg.startsWith("--window-size"))).toHaveLength(0);
    expect(result.filter((arg) => arg.startsWith("--disable-blink-features"))).toHaveLength(1);
    expect(nativeBrowserLaunchArgs({ enabled: true, viewport: { width: 1366, height: 768 } })).toContain("--window-size=1366,768");
  });
});

describe("buildStealthInitScript — balanced", () => {
  const profile = buildFingerprintProfile({ version: 145, language: "de-DE" });
  const source = buildStealthInitScript(profile, {});

  it("returns a non-empty string", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("is syntactically valid page-JS", () => {
    compiles(source);
  });

  it("deletes navigator.webdriver", () => {
    expect(source).toContain("webdriver");
    expect(source).toContain("delete");
    expect(source).toContain("Object.getPrototypeOf(navigator)");
  });

  it("does not fabricate unsupported UA, platform, version, or browser claims", () => {
    expect(source).not.toContain("Google Inc.");
    expect(source).not.toContain("HeadlessChrome");
    expect(source).not.toContain("userAgentData");
    expect(source).not.toContain("FULL_VERSION_LIST");
  });

  it("guards permissions.query against insecure origins", () => {
    expect(source).toContain("permissions");
    expect(source).toContain("PermissionStatus");
    expect(source).toContain("notifications");
  });
});

describe("buildStealthInitScript — max", () => {
  const profile = buildFingerprintProfile({ profile: "max", version: 145, language: "de-DE" });
  const balanced = buildStealthInitScript(profile, {});
  const source = buildStealthInitScript(profile, { max: true });

  it("keeps the supported balanced markers", () => {
    for (const marker of MARKERS) {
      expect(source).toContain(marker);
    }
    expect(balanced).not.toContain("hardwareConcurrency");
  });

  it("does not add unsupported identity patches in max mode", () => {
    expect(source).not.toContain("hardwareConcurrency");
    expect(source).not.toContain("deviceMemory");
    expect(source).not.toContain("plugins");
    expect(source).not.toContain("contentWindow");
  });

  it("is syntactically valid page-JS", () => {
    compiles(source);
  });
});

describe("buildStealthInitScript — coherence & determinism", () => {
  it("interpolates only an explicit viewport, not a fabricated identity", () => {
    const profile = buildFingerprintProfile({ version: 145, language: "de-DE", viewport: { width: 1366, height: 768 } });
    const source = buildStealthInitScript(profile, { applyViewport: true });
    expect(source).toContain("1366");
    expect(source).toContain("768");
    expect(source).not.toContain(JSON.stringify(profile.brands));
    expect(source).not.toContain('"145"');
  });

  it("is deterministic for identical inputs", () => {
    const profile = buildFingerprintProfile({ version: 130, language: "ja-JP" });
    expect(buildStealthInitScript(profile, {})).toBe(buildStealthInitScript(profile, {}));
    expect(buildStealthInitScript(profile, { max: true })).toBe(buildStealthInitScript(profile, { max: true }));
  });

  it("never throws compiling balanced or max", () => {
    const balanced = buildFingerprintProfile();
    const max = buildFingerprintProfile({ profile: "max" });
    compiles(buildStealthInitScript(balanced, {}));
    compiles(buildStealthInitScript(max, { max: true }));
  });
});
