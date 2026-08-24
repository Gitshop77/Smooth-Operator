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

  it("reclaims a stale profile lock after verifying its owner is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-stale-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    await writeFile(join(directory, "seed"), "seed");
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    });
    // A lock carrying a definitely dead PID must not wedge startup: the
    // runtime reclaims it atomically instead of demanding manual cleanup.
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, ".smooth-operator-profile.lock"), JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
    const runtime = await ServerRuntime.create(config);
    try {
      await expect(access(join(profile, ".smooth-operator-profile.lock"))).resolves.toBeUndefined();
    } finally {
      await runtime.close();
    }
    await expect(access(join(profile, ".smooth-operator-profile.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("still refuses an active-looking lock whose owner rejects the signal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-livelock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    });
    await mkdir(profile, { recursive: true });
    // PID 0/1 style owners are unreachable to kill() as ESRCH; simulate an
    // owner that exists by using our own PID - kill(pid, 0) then succeeds.
    await writeFile(join(profile, ".smooth-operator-profile.lock"), JSON.stringify({ pid: process.pid, token: "live" }));
    await expect(ServerRuntime.create(config)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
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
