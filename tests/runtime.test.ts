import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

describe("runtime lifecycle", () => {
  it("tightens an existing runtime directory with unsafe permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-"));
    await chmod(directory, 0o755);
    const runtime = await ServerRuntime.create(testConfig({ dataDir: directory }));
    expect((await stat(directory)).mode & 0o077).toBe(0);
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates and protects the owned browser profile before launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-profile-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const runtime = await ServerRuntime.create(testConfig({
      dataDir: directory,
      browser: {
        ...base.browser,
        mode: "launch",
        executablePath: "/usr/bin/chromium",
        userDataDir: profile,
      },
    }));
    try {
      expect((await stat(profile)).isDirectory()).toBe(true);
      expect((await stat(profile)).mode & 0o077).toBe(0);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leases the native profile and rejects concurrent owners", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: directory,
      browser: {
        ...base.browser,
        mode: "launch",
        executablePath: "/usr/bin/chromium",
        userDataDir: profile,
      },
    });
    const first = await ServerRuntime.create(config);
    try {
      await expect(ServerRuntime.create(config)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
    } finally {
      await first.close();
    }
    await expect(access(join(profile, ".smooth-operator-profile.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("leases the managed browser profile before attempting reattachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-managed-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "managed", userDataDir: profile },
    });
    const first = await ServerRuntime.create(config);
    try {
      await expect(ServerRuntime.create(config)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
    } finally {
      await first.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on stale profile locks instead of reclaiming them racy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-stale-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    await writeFile(join(directory, "seed"), "seed");
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    });
    const runtime = await ServerRuntime.create(config);
    await runtime.close();
    // The first owner released its lock; create a lock carrying a definitely
    // dead PID and verify acquisition refuses to unlink it automatically.
    await writeFile(join(profile, ".smooth-operator-profile.lock"), JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
    await expect(ServerRuntime.create(config)).rejects.toMatchObject({ code: "BROWSER_PROFILE_LOCK_FAILED" });
    await expect(access(join(profile, ".smooth-operator-profile.lock"))).resolves.toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });

  it("retains an owned profile lease when browser shutdown fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-close-failure-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const runtime = await ServerRuntime.create(testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    }));
    const internal = runtime.browser as unknown as { browser: { close(): Promise<void> }; ownsBrowser: boolean };
    internal.browser = { close: async () => { throw new Error("close failed"); } };
    internal.ownsBrowser = true;
    await runtime.close();
    await expect(access(join(profile, ".smooth-operator-profile.lock"))).resolves.toBeUndefined();
    await (runtime as unknown as { browserProfileLease?: { release(): Promise<void> } }).browserProfileLease?.release();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects a symlinked owned browser userDataDir before acquiring its lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-profile-symlink-"));
    const physicalProfile = join(directory, "physical-profile");
    const linkedProfile = join(directory, "linked-profile");
    await mkdir(physicalProfile);
    await symlink(physicalProfile, linkedProfile);
    const base = testConfig();
    await expect(ServerRuntime.create(testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: linkedProfile },
    }))).rejects.toThrow(/symbolic link|real directory/i);
    await expect(access(join(physicalProfile, ".smooth-operator-profile.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });
});
