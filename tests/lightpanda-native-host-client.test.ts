import { describe, it, expect, beforeEach } from "vitest";
import { runAgentProcess, LIGHTPANDA_HOST_NAME, NativeHostError } from "../src/extension/background/lightpanda/native-host-client";

interface FakePort {
  name: string;
  messages: unknown[];
  onMessage: { addListener: (h: (m: unknown) => void) => void; removeListener: (h: (m: unknown) => void) => void };
  onDisconnect: { addListener: (h: () => void) => void; removeListener: (h: () => void) => void };
  postMessage: (m: unknown) => void;
  disconnect: () => void;
}

let port: FakePort | undefined;
let onMessage: ((m: unknown) => void) | undefined;
let onDisconnect: (() => void) | undefined;

function installFakeChrome(): { emit(m: unknown): void; disconnect(): void } {
  port = undefined;
  onMessage = undefined;
  onDisconnect = undefined;
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: undefined,
      connectNative: (name: string) => {
        expect(name).toBe(LIGHTPANDA_HOST_NAME);
        port = {
          name,
          messages: [],
          onMessage: {
            addListener(h) { onMessage = h; },
            removeListener() { onMessage = undefined; },
          },
          onDisconnect: {
            addListener(h) { onDisconnect = h; },
            removeListener() { onDisconnect = undefined; },
          },
          postMessage(m) { port!.messages.push(m); },
          disconnect() { onDisconnect?.(); },
        };
        return port;
      },
    },
  };
  return {
    emit(m) { onMessage?.(m); },
    disconnect() { onDisconnect?.(); },
  };
}

beforeEach(() => { delete (globalThis as Record<string, unknown>).chrome; });

describe("runAgentProcess", () => {
  it("resolves with accumulated output on done", async () => {
    const { emit } = installFakeChrome();
    const p = runAgentProcess({ args: ["agent"], env: {} });
    const sent = port!.messages[0] as { id: string; type: string };
    expect(sent.type).toBe("agent");
    emit({ id: sent.id, type: "chunk", channel: "stdout", data: "answer" });
    emit({ id: sent.id, type: "chunk", channel: "stderr", data: "$usage prompt=5 completion=3 total=8 cached=0 cache_creation=0\n" });
    emit({ id: sent.id, type: "done", exitCode: 0 });
    await expect(p).resolves.toEqual({ stdout: "answer", stderr: "$usage prompt=5 completion=3 total=8 cached=0 cache_creation=0\n", exitCode: 0, timedOut: false });
  });

  it("rejects on host error", async () => {
    const { emit } = installFakeChrome();
    const p = runAgentProcess({ args: ["agent"], env: {} });
    emit({ id: (port!.messages[0] as { id: string }).id, type: "error", message: "boom" });
    await expect(p).rejects.toThrow(NativeHostError);
  });

  it("rejects on disconnect with lastError", async () => {
    const fake = installFakeChrome();
    (chrome.runtime as { lastError?: { message: string } }).lastError = { message: "port closed" };
    const p = runAgentProcess({ args: ["agent"], env: {} });
    fake.disconnect();
    await expect(p).rejects.toThrow(/port closed/);
  });

  it("rejects with AbortError when aborted mid-run", async () => {
    const { emit } = installFakeChrome();
    const ac = new AbortController();
    const p = runAgentProcess({ args: ["agent"], env: {} }, ac.signal);
    ac.abort();
    expect((port!.messages[1] as { type: string }).type).toBe("cancel");
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    emit({ id: (port!.messages[0] as { id: string }).id, type: "done", exitCode: 0 });
  });

  it("rejects with NativeHostError when the host reports cancelled", async () => {
    const { emit } = installFakeChrome();
    const p = runAgentProcess({ args: ["agent"], env: {} });
    emit({ id: (port!.messages[0] as { id: string }).id, type: "cancelled" });
    await expect(p).rejects.toThrow(/cancelled/);
  });
});