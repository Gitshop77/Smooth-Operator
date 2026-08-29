import { describe, expect, it } from "vitest";

import { buildFingerprintProfile } from "@/server/browser/fingerprints";
import { NATIVE_BROWSER_LAUNCH_ARGS, nativeBrowserLaunchArgs } from "@/server/browser/compatibility";
import { buildStealthInitScript, STEALTH_BASELINE_ARGS } from "@/server/browser/stealth";

function compiles(source: string): void {
  expect(() => new Function(source)).not.toThrow();
}

describe("browser identity-preserving compatibility", () => {
  it("does not add identity or automation-evasion launch flags", () => {
    expect(STEALTH_BASELINE_ARGS).toEqual([]);
    const result = nativeBrowserLaunchArgs({ enabled: true, gpu: true });
    expect(result).not.toContain("--disable-blink-features=AutomationControlled");
    expect(result).not.toContain("--ignore-certificate-errors");
    expect(result).not.toContain("--disable-web-security");
    expect(result).not.toContain("--no-sandbox");
    expect(result).toContain("--use-angle=vulkan");
    expect(result).toContain("--enable-vulkan");
  });

  it("keeps launch arrays fresh and applies only an explicit viewport", () => {
    const result = nativeBrowserLaunchArgs({ enabled: true, viewport: { width: 1_366, height: 768 } });
    expect(result.filter((value) => value.startsWith("--window-size"))).toEqual(["--window-size=1366,768"]);
    expect(nativeBrowserLaunchArgs()).toEqual([...NATIVE_BROWSER_LAUNCH_ARGS]);
    expect(nativeBrowserLaunchArgs()).not.toBe(nativeBrowserLaunchArgs());
  });

  it("produces a small valid page script without browser API patches", () => {
    const source = buildStealthInitScript(buildFingerprintProfile({ viewport: { width: 1_366, height: 768 } }), { applyViewport: true });
    compiles(source);
    expect(source).toContain("APPLY_VIEWPORT");
    expect(source).toContain("1366");
    expect(source).toContain("768");
    expect(source).not.toContain("Object.getPrototypeOf(navigator)");
    expect(source).not.toContain("permissions.query");
    expect(source).not.toContain("webdriver");
  });
});
