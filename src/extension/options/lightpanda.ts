/** Lightpanda research settings — Options → Automation. */
import { LIGHTPANDA_STORAGE_KEYS, LIGHTPANDA_DEFAULTS } from "../lightpanda-settings";
import { LIGHTPANDA_HOST_NAME } from "../background/lightpanda/native-host-client";

export function renderLightpanda(): void {
  const container = document.getElementById("lightpandaSection");
  if (!container) return;
  container.innerHTML = `
    <h3>Lightpanda research</h3>
    <p class="section-desc">When the agent needs fresh web information, the <code>research</code> action launches the Lightpanda headless browser with your main AI to find and synthesize answers outside your current tab.</p>
    <label><input type="checkbox" id="lpEnabled"> Enable research (default on)</label>
    <p><label>Lightpanda binary path (optional; default: <code>lightpanda</code> on PATH)<br>
      <input type="text" id="lpBinaryPath" style="width:100%" placeholder="/usr/local/bin/lightpanda">
    </label></p>
    <p><label>Brave Search API key (optional — improves Lightpanda's built-in search)<br>
      <input type="password" id="lpBraveKey" style="width:100%" autocomplete="off">
    </label></p>
    <p><label>Tavily API key (optional)<br>
      <input type="password" id="lpTavilyKey" style="width:100%" autocomplete="off">
    </label></p>
    <p><label>Timeout (seconds, 10–600, default 120)<br>
      <input type="number" id="lpTimeout" min="10" max="600" value="120" style="width:120px">
    </label></p>
    <p><button type="button" id="lpSave">Save</button>
      <button type="button" id="lpTest">Test connection</button>
      <span id="lpStatusText" role="status"></span></p>
    <p class="section-desc">One-time host setup (macOS/Linux): run<br>
      <code>npm run setup:lightpanda-host -- --extension-id ${chrome.runtime.id}</code><br>
      then reload the extension. The host must be re-run after reinstalling Chrome (the extension id changes). Note: the model used by research must exist in your provider's catalog (e.g. Azure deployment names must match the model, Ollama models must be pulled first).</p>
  `;
  const get = async <T>(key: string, fallback: T): Promise<T> => {
    const stored = await chrome.storage.local.get(key);
    return (stored[key] as T | undefined) ?? fallback;
  };
  void get(LIGHTPANDA_STORAGE_KEYS.enabled, LIGHTPANDA_DEFAULTS.enabled).then((v) => { (container.querySelector("#lpEnabled") as HTMLInputElement).checked = v; });
  void get(LIGHTPANDA_STORAGE_KEYS.binaryPath, "").then((v) => { (container.querySelector("#lpBinaryPath") as HTMLInputElement).value = v; });
  void get(LIGHTPANDA_STORAGE_KEYS.braveKey, "").then((v) => { (container.querySelector("#lpBraveKey") as HTMLInputElement).value = v; });
  void get(LIGHTPANDA_STORAGE_KEYS.tavilyKey, "").then((v) => { (container.querySelector("#lpTavilyKey") as HTMLInputElement).value = v; });
  void get(LIGHTPANDA_STORAGE_KEYS.timeoutSeconds, 120).then((v) => { (container.querySelector("#lpTimeout") as HTMLInputElement).value = String(v); });
  const status = (text: string): void => { (container.querySelector("#lpStatusText") as HTMLSpanElement).textContent = text; };
  container.querySelector("#lpSave")!.addEventListener("click", () => {
    void chrome.storage.local.set({
      [LIGHTPANDA_STORAGE_KEYS.enabled]: (container.querySelector("#lpEnabled") as HTMLInputElement).checked,
      [LIGHTPANDA_STORAGE_KEYS.binaryPath]: (container.querySelector("#lpBinaryPath") as HTMLInputElement).value.trim(),
      [LIGHTPANDA_STORAGE_KEYS.braveKey]: (container.querySelector("#lpBraveKey") as HTMLInputElement).value.trim(),
      [LIGHTPANDA_STORAGE_KEYS.tavilyKey]: (container.querySelector("#lpTavilyKey") as HTMLInputElement).value.trim(),
      [LIGHTPANDA_STORAGE_KEYS.timeoutSeconds]: Number((container.querySelector("#lpTimeout") as HTMLInputElement).value) || 120,
    });
    status("Saved.");
  });
  container.querySelector("#lpTest")!.addEventListener("click", () => {
    status("Testing…");
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(LIGHTPANDA_HOST_NAME);
    } catch {
      status("Native host not found — run the setup command above, then reload the extension.");
      return;
    }
    // A successful pong (or a timeout) deliberately disconnects the port, which
    // fires onDisconnect; the settled guard keeps that callback from
    // overwriting the success/timeout verdict with the not-found message.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      status("No response (timeout).");
      try { port.disconnect(); } catch { /* ignore */ }
    }, 8_000);
    // chrome.runtime.Port events: addListener/removeListener only.
    const onMessage = (m: unknown): void => {
      if ((m as { type?: string }).type === "pong") {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        status("OK — Lightpanda host is reachable.");
      }
      try { port.disconnect(); } catch { /* ignore */ }
    };
    const onDisconnect = (): void => {
      clearTimeout(timer);
      try { port.onMessage.removeListener(onMessage); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      status("Native host not found — run the setup command above, then reload the extension.");
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({ id: "ping", type: "ping" });
  });
}
