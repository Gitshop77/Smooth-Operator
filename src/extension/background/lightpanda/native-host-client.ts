/**
 * Native-messaging client for the Open Cowork Lightpanda host.
 *
 * The host (scripts/lightpanda-native-host.mjs) is spawned by Chrome from the
 * launcher installed by `npm run setup:lightpanda-host`. It spawns
 * `lightpanda agent --task …` on demand and streams stdout/stderr back; this
 * client correlates request ids, accumulates the stream, and propagates
 * abort/timeout into a cancel message.
 */

export const LIGHTPANDA_HOST_NAME = "com.open_cowork.lightpanda";

export interface AgentProcessRequest {
  /** Absolute path override; omitted = host default (baked at setup time). */
  binary?: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface AgentProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class NativeHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeHostError";
  }
}

export function runAgentProcess(
  request: AgentProcessRequest,
  signal?: AbortSignal,
): Promise<AgentProcessResult> {
  return new Promise<AgentProcessResult>((resolve, reject) => {
    if (typeof chrome === "undefined" || typeof chrome.runtime?.connectNative !== "function") {
      reject(new NativeHostError("chrome.runtime.connectNative unavailable — research only works in the installed extension"));
      return;
    }
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(LIGHTPANDA_HOST_NAME);
    } catch (e) {
      reject(new NativeHostError(
        `cannot connect to native host "${LIGHTPANDA_HOST_NAME}" (${e instanceof Error ? e.message : String(e)}). Run "npm run setup:lightpanda-host" and reload the extension.`,
      ));
      return;
    }
    const id = `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = (): void => {
      try { port.postMessage({ id, type: "cancel" }); } catch { /* ignore */ }
      finish(() => reject(new DOMException("research aborted", "AbortError")));
    };
    const onMessage = (msg: unknown): void => {
      const m = msg as {
        id?: string; type?: string; channel?: string; data?: string;
        exitCode?: number | null; timeout?: boolean; message?: string;
      };
      if (!m || m.id !== id) return;
      if (m.type === "chunk") {
        if (m.channel === "stdout") stdout += m.data ?? "";
        else if (m.channel === "stderr") stderr += m.data ?? "";
      } else if (m.type === "done") {
        clearTimeout(timer);
        finish(() => resolve({ stdout, stderr, exitCode: m.exitCode ?? null, timedOut: m.timeout === true }));
      } else if (m.type === "cancelled") {
        clearTimeout(timer);
        finish(() => reject(new NativeHostError("lightpanda research cancelled by the native host")));
      } else if (m.type === "error") {
        clearTimeout(timer);
        finish(() => reject(new NativeHostError(m.message ?? "native host error")));
      }
    };
    const onDisconnect = (): void => {
      clearTimeout(timer);
      const lastError = chrome.runtime?.lastError?.message;
      finish(() => reject(new NativeHostError(lastError ? `native host disconnected: ${lastError}` : "native host disconnected")));
    };
    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        port.disconnect();
      } catch { /* port already closed */ }
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const timer = setTimeout(() => {
      try { port.postMessage({ id, type: "cancel" }); } catch { /* ignore */ }
      finish(() => reject(new NativeHostError(`lightpanda research timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs + 5_000);

    // chrome.runtime.Port.onMessage/onDisconnect are events (H26):
    // addListener/removeListener only.
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    port.postMessage({
      id,
      type: "agent",
      args: request.args,
      ...(request.binary ? { binary: request.binary } : {}),
      env: request.env,
      timeoutMs,
    });
  });
}
