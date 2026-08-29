import { describe, it, expect, vi } from "vitest";
import { launchPersonalChrome } from "@/server/installer-wizard";

describe("personal chrome helper", () => {
  it("spawns Chrome and probes 9222 until live", async () => {
    const mockSpawn = vi.fn(() => ({ unref: vi.fn(), pid: 123 } as any));
    const mockProbe = vi.fn().mockResolvedValueOnce({ state: "no-file" }).mockResolvedValueOnce({ state: "live", version: { Browser: "Chrome/144" } });
    const result = await launchPersonalChrome({ executablePath: process.execPath, dataDir: "/tmp/test-home/.smooth-operator", port: 9222, spawn: mockSpawn, probe: mockProbe });
    expect(mockSpawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(["--remote-debugging-port=9222"]), expect.objectContaining({ detached: true }));
    expect(result.url).toBe("http://127.0.0.1:9222");
  });

  it("surfaces a connect-timeout error when the endpoint never becomes live", async () => {
    const mockSpawn = vi.fn(() => ({ unref: vi.fn(), pid: 7 } as any));
    const mockProbe = vi.fn().mockResolvedValue({ state: "no-file" });
    await expect(launchPersonalChrome({
      executablePath: process.execPath, dataDir: "/tmp/test-home/.smooth-operator",
      port: 9222, spawn: mockSpawn, probe: mockProbe, probeAttempts: 2,
    })).rejects.toMatchObject({ code: "BROWSER_CONNECT_TIMEOUT" });
  }, 15_000);
});
