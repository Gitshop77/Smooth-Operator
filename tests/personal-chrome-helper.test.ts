import { EventEmitter } from "node:events";

import { describe, it, expect, vi } from "vitest";
import { launchPersonalChrome } from "@/server/installer-wizard";

function mockChild() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    unref: vi.fn(),
    kill: vi.fn(() => true),
    pid: 123,
  };
}

describe("personal chrome helper", () => {
  it("spawns Chrome and probes 9222 until live", async () => {
    const child = mockChild();
    const mockSpawn = vi.fn(() => child as any);
    const mockProbe = vi.fn().mockResolvedValueOnce({ state: "no-file" }).mockResolvedValueOnce({ state: "live", version: { Browser: "Chrome/144" } });
    const result = await launchPersonalChrome({ executablePath: process.execPath, dataDir: "/tmp/test-home/.smooth-operator", port: 9222, spawn: mockSpawn, probe: mockProbe });
    expect(mockSpawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["--remote-debugging-port=9222"]), expect.objectContaining({ detached: true }));
    expect(result.url).toBe("http://127.0.0.1:9222");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("surfaces a connect-timeout error when the endpoint never becomes live", async () => {
    const child = mockChild();
    const mockSpawn = vi.fn(() => child as any);
    const mockProbe = vi.fn().mockResolvedValue({ state: "no-file" });
    await expect(launchPersonalChrome({
      executablePath: process.execPath, dataDir: "/tmp/test-home/.smooth-operator",
      port: 9222, spawn: mockSpawn, probe: mockProbe, probeAttempts: 2,
    })).rejects.toMatchObject({ code: "BROWSER_CONNECT_TIMEOUT" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  }, 15_000);

  it("kills Chrome when every readiness probe throws", async () => {
    const child = mockChild();
    const mockProbe = vi.fn().mockRejectedValue(new Error("probe failed"));
    await expect(launchPersonalChrome({
      executablePath: process.execPath,
      dataDir: "/tmp/test-home/.smooth-operator",
      spawn: vi.fn(() => child as any),
      probe: mockProbe,
      probeAttempts: 2,
    })).rejects.toMatchObject({ code: "BROWSER_CONNECT_TIMEOUT" });
    expect(mockProbe).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("maps an asynchronous spawn error and cleans up the child", async () => {
    const child = mockChild();
    const mockProbe = vi.fn(async () => {
      queueMicrotask(() => { child.emit("error", new Error("spawn failed")); });
      return { state: "no-file" };
    });
    await expect(launchPersonalChrome({
      executablePath: process.execPath,
      dataDir: "/tmp/test-home/.smooth-operator",
      spawn: vi.fn(() => child as any),
      probe: mockProbe,
      probeAttempts: 1,
    })).rejects.toMatchObject({ code: "BROWSER_LAUNCH_FAILED" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
