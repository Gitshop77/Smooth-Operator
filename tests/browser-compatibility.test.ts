import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadServerConfig } from "@/server/config";
import { NATIVE_BROWSER_LAUNCH_ARGS, nativeBrowserLaunchArgs } from "@/server/browser/compatibility";

describe("native browser compatibility profile", () => {
  it("uses one private persistent profile by default", () => {
    const dataDir = join(tmpdir(), "smooth-operator-compatibility");
    const config = loadServerConfig([], {
      SMOOTH_OPERATOR_DATA_DIR: dataDir,
      SMOOTH_OPERATOR_BROWSER_MODE: "launch",
      SMOOTH_OPERATOR_BROWSER_EXECUTABLE: "/usr/bin/chromium",
    });

    expect(config.browser.userDataDir).toBe(join(dataDir, "browser"));
  });

  it("returns a fresh copy of the audited launch defaults", () => {
    const first = nativeBrowserLaunchArgs();
    const second = nativeBrowserLaunchArgs();

    expect(first).toEqual([...NATIVE_BROWSER_LAUNCH_ARGS]);
    expect(first).not.toBe(second);
    first.push("--test-only");
    expect(nativeBrowserLaunchArgs()).toEqual([...NATIVE_BROWSER_LAUNCH_ARGS]);
  });

  it("does not include identity, security, or automation-evasion switches", () => {
    const args = nativeBrowserLaunchArgs();
    expect(args).not.toContain("--disable-blink-features=AutomationControlled");
    expect(args).not.toContain("--ignore-certificate-errors");
    expect(args).not.toContain("--disable-web-security");
    expect(args).not.toContain("--no-sandbox");
  });
});
