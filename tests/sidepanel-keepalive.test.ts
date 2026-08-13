import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("side-panel service-worker keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("sends real port traffic every 20 seconds and reconnects after disconnect", async () => {
    const ports: Array<{
      postMessage: ReturnType<typeof vi.fn>;
      disconnect: () => void;
    }> = [];
    const connect = vi.fn(() => {
      let onDisconnect: (() => void) | undefined;
      const port = {
        postMessage: vi.fn(),
        onDisconnect: { addListener: (fn: () => void) => { onDisconnect = fn; } },
      };
      ports.push({ postMessage: port.postMessage, disconnect: () => onDisconnect?.() });
      return port;
    });
    Object.assign(globalThis, {
      chrome: { runtime: { connect } },
    });

    const { startKeepalivePort } = await import("../src/extension/sidepanel/keepalive");
    startKeepalivePort();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(ports[0].postMessage).toHaveBeenCalledWith({ type: "KEEPALIVE_PING" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(ports[0].postMessage).toHaveBeenCalledTimes(2);

    ports[0].disconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ports[1].postMessage).toHaveBeenCalledTimes(1);
  });

  test("start is idempotent while a port is connected", async () => {
    const connect = vi.fn(() => ({
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    }));
    Object.assign(globalThis, { chrome: { runtime: { connect } } });
    const { startKeepalivePort } = await import("../src/extension/sidepanel/keepalive");

    startKeepalivePort();
    startKeepalivePort();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
