import { access, chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Browser } from "puppeteer-core";
import { ServerRuntime } from "@/server/runtime";

import { testConfig } from "./helpers";

describe("runtime lifecycle", () => {
  it("exposes idle cleanup in capabilities and retains the profile lease after an idle close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-idle-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile, idleTimeoutMs: 1_000 },
    });
    const runtime = await ServerRuntime.create(config);
    const disconnect = vi.fn(async () => undefined);
    const browser = { connected: true, disconnect, on: vi.fn() } as unknown as Browser;
    const internal = runtime.browser as unknown as { browser?: Browser; ownsBrowser: boolean; lastActivityAt: number; idleSweepTimer?: unknown };
    internal.browser = browser;
    internal.ownsBrowser = false;
    internal.lastActivityAt = Date.now() - 2_000;
    const lockPath = join(profile, ".smooth-operator-profile.lock");

    try {
      expect(runtime.publicCapabilities()).toMatchObject({ browser: { idleTimeoutMs: 1_000, runtime: { idleTimeoutMs: 1_000 } } });
      await expect(access(lockPath)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(500);
      expect(disconnect).toHaveBeenCalledTimes(1);
      await expect(access(lockPath)).resolves.toBeUndefined();
    } finally {
      await runtime.close();
      expect(internal.idleSweepTimer).toBeUndefined();
      vi.useRealTimers();
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports native feature defaults and effective challenge guarantees", async () => {
    const runtime = await ServerRuntime.create(testConfig());
    try {
      expect(runtime.publicCapabilities()).toMatchObject({
        defaults: { browserMode: "managed", headedBrowser: true, pageEvaluation: true, stealth: true, behavioralTiming: false },
        features: { localBrowserTools: "available", pageEvaluation: false, stealth: false, behavioralTiming: false },
        challenges: { classification: "bounded-evidence", connectedAiLoop: true, humanHandoff: true, successRequiresAbsentClassification: true, defaultMaxAttempts: 32, maxAttempts: 100 },
      });
    } finally {
      await runtime.close();
    }
  });

  it("tightens an existing runtime directory with unsafe permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-"));
    await chmod(directory, 0o755);
    const runtime = await ServerRuntime.create(testConfig({ dataDir: directory }));
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o077).toBe(0);
    }
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
      if (process.platform !== "win32") {
        expect((await stat(profile)).mode & 0o077).toBe(0);
      }
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets concurrent sessions connect; only simultaneous browsing conflicts", async () => {
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
    let second: ServerRuntime | undefined;
    try {
      // A second harness session must stay fully connected while the first
      // owns the profile lease; only its browser operations conflict.
      second = await ServerRuntime.create(config);
      await expect(second.run({ action: "navigate", url: "https://example.test/" } as never)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(second.listTabs(cancelled.signal)).rejects.toMatchObject({ code: "CANCELLED" });
      // Once the owner releases, the survivor can acquire the lease lazily.
      await first.close();
      const lease = second as unknown as { ensureBrowserProfileLease(): Promise<void> };
      await expect(lease.ensureBrowserProfileLease()).resolves.toBeUndefined();
    } finally {
      await first.close().catch(() => undefined);
      await second?.close();
    }
    await expect(access(join(profile, ".smooth-operator-profile.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("serializes lazy profile acquisition for concurrent requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-lazy-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    });
    const owner = await ServerRuntime.create(config);
    const waiting = await ServerRuntime.create(config);
    try {
      await owner.close();
      const internal = waiting as unknown as { ensureBrowserProfileLease(): Promise<void> };
      await expect(Promise.all([internal.ensureBrowserProfileLease(), internal.ensureBrowserProfileLease()])).resolves.toEqual([undefined, undefined]);
      await expect(access(join(profile, ".smooth-operator-profile.lock"))).resolves.toBeUndefined();
    } finally {
      await owner.close().catch(() => undefined);
      await waiting.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a shared profile acquisition after one waiter cancels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-cancel-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const config = testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    });
    const owner = await ServerRuntime.create(config);
    const waiting = await ServerRuntime.create(config);
    try {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const internal = waiting as unknown as { ensureBrowserProfileLease(signal?: AbortSignal): Promise<void>; profileLeasePromise?: Promise<void> };
      internal.profileLeasePromise = pending;
      const cancelled = new AbortController();
      cancelled.abort();

      await expect(internal.ensureBrowserProfileLease(cancelled.signal)).rejects.toMatchObject({ code: "CANCELLED" });
      expect(internal.profileLeasePromise).toBe(pending);
      release();
      await expect(internal.ensureBrowserProfileLease()).resolves.toBeUndefined();
    } finally {
      await owner.close();
      await waiting.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects new work after shutdown begins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-closed-"));
    const runtime = await ServerRuntime.create(testConfig({ dataDir: directory }));
    await runtime.close();
    await expect(runtime.run({ action: "list_tabs" } as never)).rejects.toMatchObject({ code: "SERVER_CLOSING", retryable: true });
    await expect(runtime.webSearch("closed", {})).rejects.toMatchObject({ code: "SERVER_CLOSING", retryable: true });
    expect(() => runtime.listSessions()).toThrowError(/shutting down/i);
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
    let second: ServerRuntime | undefined;
    try {
      // Startup stays healthy under contention; the conflict surfaces only
      // when the second session actually drives the managed browser.
      second = await ServerRuntime.create(config);
      await expect(second.snapshot({ url: "https://example.test/" } as never)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
    } finally {
      await first.close();
      await second?.close();
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
      expect((await readdir(profile)).some((entry) => entry.startsWith(".smooth-operator-profile.lock.stale-"))).toBe(false);
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
    const runtime = await ServerRuntime.create(config);
    try {
      await expect(runtime.run({ action: "navigate", url: "https://example.test/" } as never)).rejects.toMatchObject({ code: "BROWSER_PROFILE_IN_USE" });
    } finally {
      await runtime.close();
      // The live-owner lock must survive our shutdown untouched.
      await expect(access(join(profile, ".smooth-operator-profile.lock"))).resolves.toBeUndefined();
    }
    await rm(directory, { recursive: true, force: true });
  });

  it("does not remove a replacement profile lock during lease release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-lock-race-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const runtime = await ServerRuntime.create(testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    }));
    const lockPath = join(profile, ".smooth-operator-profile.lock");
    try {
      const lease = (runtime as unknown as { browserProfileLease?: { release(): Promise<void> } }).browserProfileLease;
      expect(lease).toBeDefined();
      await unlink(lockPath);
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "replacement" }));
      await lease?.release();
      await expect(access(lockPath)).resolves.toBeUndefined();
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds shutdown while a profile lease acquisition is uncooperative", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smooth-operator-runtime-close-pending-lock-"));
    const profile = join(directory, "browser");
    const base = testConfig();
    const runtime = await ServerRuntime.create(testConfig({
      dataDir: directory,
      browser: { ...base.browser, mode: "launch", executablePath: "/usr/bin/chromium", userDataDir: profile },
    }));
    const internal = runtime as unknown as { profileLeasePromise?: Promise<void> };
    internal.profileLeasePromise = new Promise<void>(() => undefined);
    try {
      const result = await Promise.race([
        runtime.close().then(() => "closed" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_500)),
      ]);
      expect(result).toBe("closed");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
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
