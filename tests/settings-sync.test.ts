/**
 * Domain validators in `options/settings-sync.ts`.
 *
 * `settings-sync.ts` runs storage + DOM side-effects at import time (it builds
 * the provider <select> and wires load handlers), so we stub `chrome` and set
 * up the minimal element set before the dynamic import.
 */

import { describe, test, expect, beforeAll, vi } from "vitest";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import { IDBFactory } from "fake-indexeddb";

// Shared spy over the SSRF webhook validator so tests can simulate transient
// DNS failures without real chrome.dns. Defaults to the real implementation.
const webhookResolveMock = vi.fn();
vi.mock("@/lib/agent/llm/route/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/llm/route/ssrf")>();
  webhookResolveMock.mockImplementation((url: string) => actual.resolveAndValidateWebhookUrl(url));
  return { ...actual, resolveAndValidateWebhookUrl: webhookResolveMock };
});

// Inspectable storage maps, (re)assigned by setupGlobals so tests can assert
// what saveSettings() persisted.
let localStore: Map<string, unknown>;
let sessionStore: Map<string, unknown>;

/** The provider id currently selected in the (populated) provider <select>. */
function activeProviderId(): string {
  const sel = document.getElementById("provider") as HTMLSelectElement;
  return sel.options[sel.selectedIndex]?.value || sel.value || "openai";
}

function setupGlobals(): void {
  localStore = new Map<string, unknown>();
  sessionStore = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = makeChromeStorageMock(localStore, sessionStore);
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

  // Elements touched during import-time load + updateProviderUI.
  document.body.innerHTML = `
    <select id="provider"></select>
    <button id="testConnection"></button>
    <input id="model">
    <span id="provider-hint"></span>
    <input id="apiKey">
    <input type="checkbox" id="rememberApiKey" />
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <input id="baseUrl">
    <input id="maxSteps">
    <input id="maxActions">
    <input id="plannerInterval">
    <input id="maxFailures">
    <input id="costCap">
    <textarea id="defaultTask"></textarea>
    <input id="screenshotQuality">
    <input id="screenshotImageTokens">
    <input id="screenshotMaxDimension">
    <input id="screenshotMaxBytes">
    <input id="enableScreenshots">
    <input type="checkbox" id="enableStealth" />
    <textarea id="allowedDomains"></textarea>
    <textarea id="blockedDomains"></textarea>
    <input id="notifyOnCompletion">
    <input id="notifyOnError">
    <input id="notifyOnTakeover">
    <input id="webhookUrl">
    <div id="saved"></div>
    <button id="addSecret"></button>
    <input id="secretName">
    <input id="secretValue">
    <div id="secretsList"></div>
    <input id="resourceName">
    <select id="reasoningEffort">
      <option value="low">low</option>
      <option value="medium" selected>medium</option>
      <option value="high">high</option>
    </select>
    <input id="reasoningBudget">
    <select id="forceReasoning">
      <option value="auto" selected>auto</option>
      <option value="on">on</option>
      <option value="off">off</option>
    </select>
    <input id="contextTokens">
  `;
}

describe("settings-sync URL/hostname validators", () => {
  let isHttpUrl: (v: string) => boolean;
  let isHostname: (v: string) => boolean;
  let readInt: (id: string, def: number, min: number, max: number, invalid: string[]) => number;

  beforeAll(async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    isHttpUrl = mod.isHttpUrl;
    isHostname = mod.isHostname;
    readInt = mod.readInt;
  });

  test("isHttpUrl accepts http(s) and rejects others", () => {
    expect(isHttpUrl("http://x")).toBe(true);
    expect(isHttpUrl("https://x")).toBe(true);
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false); // non-http(s) scheme
  });

  test("isHostname accepts bare hostnames incl. IPv6, rejects scheme/port/path", () => {
    // URL.hostname returns bracketed IPv6 ("[2001:db8::1]") for
    // "http://[2001:db8::1]"; isIpv6Literal compares against the bracketed
    // form, so real IPv6 literals are accepted (previously the comparison was
    // unbracketed and rejected them).
    expect(isHostname("2001:db8::1")).toBe(true); // bare IPv6 literal
    expect(isHostname("evil.com:9999")).toBe(false); // host:port
    expect(isHostname("EXAMPLE.com")).toBe(true); // IDN/uppercase
    expect(isHostname("*.example.com")).toBe(true); // wildcard
    expect(isHostname("a/b")).toBe(false); // path
    expect(isHostname("http://x.com")).toBe(false); // scheme
    expect(isHostname("gggg::")).toBe(false); // non-hex IPv6-ish
    expect(isHostname("fe80::1%eth0")).toBe(false); // IPv6 zone-id must be rejected
  });

  test("readInt rejects trailing junk and resets to default", () => {
    const el = document.getElementById("maxSteps") as HTMLInputElement;
    el.value = "5abc"; // trailing junk: parseInt("5abc") -> 5 but must be rejected
    const invalid: string[] = [];
    const result = readInt("maxSteps", 100, 1, 500, invalid);
    expect(result).toBe(100); // default
    expect(invalid).toContain("maxSteps");
    expect(el.value).toBe("100"); // reset to default
  });
});

describe("settings-sync stealthEnabled serialization", () => {
  // `stealthEnabled` is read at load (`setChecked`), written at save
  // (`saveSettings`) and listed in the serialized keys, but no test exercised
  // its round-trip. A regression dropping the field from
  // serialization/restore would otherwise pass silently. The stealth
  // DEFAULT-OFF guard itself is intact — we only verify the field survives
  // save/load.

  test("saveSettings persists the enableStealth checkbox as a strict boolean", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    const cb = document.getElementById("enableStealth") as HTMLInputElement;
    cb.checked = true;
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.get("stealthEnabled")).toBe(true);
    // DEFAULT-OFF guard: an unchecked box must persist exactly `false`, never a
    // truthy-but-non-true value that isStealthEnabled() would also reject.
    cb.checked = false;
    await mod.saveSettings();
    expect(localStore.get("stealthEnabled")).toBe(false);
  });

  test("import-time load reflects a restored stealthEnabled=true as a checked box", async () => {
    setupGlobals();
    // Seed the persisted flag BEFORE the module's import-time load callback runs.
    localStore.set("stealthEnabled", true);
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    const cb = document.getElementById("enableStealth") as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });
});

describe("settings-sync rememberApiKey round-trip", () => {
  test("checked checkbox persists an opaque manifest without local plaintext", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    const keyInput = document.getElementById("apiKey") as HTMLInputElement;
    const cb = document.getElementById("rememberApiKey") as HTMLInputElement;
    keyInput.value = "sk-remember";
    cb.checked = true;
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.has("apiKey")).toBe(false);
    expect(localStore.get("rememberApiKey")).toBe(true);
    expect(localStore.get("open_cowork_credential_manifest_v1")).toMatchObject({
      version: 1, providerId: "openai", revision: 1,
    });
  });

  test("unchecked checkbox removes key from local and clears flag", async () => {
    setupGlobals();
    localStore.set("apiKey", "sk-stale");
    localStore.set("rememberApiKey", true);
    const mod = await import("../src/extension/options/settings-sync");
    const keyInput = document.getElementById("apiKey") as HTMLInputElement;
    const cb = document.getElementById("rememberApiKey") as HTMLInputElement;
    keyInput.value = "sk-new";
    cb.checked = false;
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.has("apiKey")).toBe(false);
    expect(localStore.get("rememberApiKey")).toBe(false);
  });

  test("import-time load reflects a restored rememberApiKey=true as a checked box", async () => {
    setupGlobals();
    localStore.set("rememberApiKey", true);
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    const cb = document.getElementById("rememberApiKey") as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  test("import-time load reflects an absent consent flag as an unchecked box", async () => {
    setupGlobals();
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    const cb = document.getElementById("rememberApiKey") as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });
});

describe("migrateSecretsFromLocalToSession consent behavior", () => {
  test("showSaved is non-throwing when the #saved node is absent", async () => {
    setupGlobals();
    document.getElementById("saved")?.remove();
    const { showSaved } = await import("../src/extension/options/settings-sync-utils");
    expect(() => showSaved()).not.toThrow();
  });

  test("migrates a consented local mirror into the vault before removing plaintext", async () => {
    setupGlobals();
    localStore.set("apiKey", "sk-legacy");
    localStore.set("rememberApiKey", true);
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    expect(sessionStore.get("apiKey")).toBe("sk-legacy");
    expect(localStore.has("apiKey")).toBe(false);
    expect(localStore.get("open_cowork_credential_manifest_v1")).toMatchObject({
      version: 1, providerId: "openai", revision: 1,
    });
  });

  test("moves the key out of local when consent is NOT set", async () => {
    setupGlobals();
    localStore.set("apiKey", "sk-legacy");
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    expect(sessionStore.get("apiKey")).toBe("sk-legacy");
    expect(localStore.has("apiKey")).toBe(false);
  });

  test("moves the key out of local when the consent flag is truthy but not exactly true", async () => {
    setupGlobals();
    localStore.set("apiKey", "sk-legacy");
    localStore.set("rememberApiKey", "true");
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    expect(sessionStore.get("apiKey")).toBe("sk-legacy");
    expect(localStore.has("apiKey")).toBe(false);
  });

  test("no local key → no-op", async () => {
    setupGlobals();
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    expect(sessionStore.size).toBe(0);
    expect(localStore.size).toBe(0);
  });
});

describe("migrateSecretsFromLocalToSession newer-session-key guard", () => {
  test("never overwrites a session key that a save already wrote", async () => {
    setupGlobals();
    sessionStore.set("apiKey", "sk-newer");
    localStore.set("apiKey", "sk-stale");
    vi.resetModules();
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    expect(sessionStore.get("apiKey")).toBe("sk-newer");
    // The stale local mirror is left alone too — the save that wrote the
    // session key is the authority over the local mirror.
    expect(localStore.get("apiKey")).toBe("sk-stale");
  });
});

describe("migrateSecretsFromLocalToSession duplicate handling", () => {
  test("keeps a local secret that differs from the session entry", async () => {
    setupGlobals();
    localStore.set("open_cowork_secrets", [{ name: "TOKEN", value: "local-value" }]);
    sessionStore.set("open_cowork_secrets", [{ name: "TOKEN", value: "session-value" }]);
    vi.resetModules();
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    // Differing local value is NOT counted as migrated, so it is not dropped.
    expect(localStore.get("open_cowork_secrets")).toEqual([{ name: "TOKEN", value: "local-value" }]);
    expect(sessionStore.get("open_cowork_secrets")).toEqual([{ name: "TOKEN", value: "session-value" }]);
  });

  test("removes a local secret identical to the session entry", async () => {
    setupGlobals();
    localStore.set("open_cowork_secrets", [{ name: "TOKEN", value: "same" }]);
    sessionStore.set("open_cowork_secrets", [{ name: "TOKEN", value: "same" }]);
    vi.resetModules();
    const { migrateSecretsFromLocalToSession } =
      await import("../src/extension/options/settings-sync-utils");
    await migrateSecretsFromLocalToSession();
    expect(localStore.has("open_cowork_secrets")).toBe(false);
  });
});

describe("webhook URL validation on save", () => {
  test("transient DNS failure keeps the previous webhook and does not clear the field", async () => {
    setupGlobals();
    localStore.set("webhookUrl", "https://old.example.com/hook");
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    webhookResolveMock.mockClear();
    webhookResolveMock.mockResolvedValueOnce({
      ok: false,
      reason: "DNS resolution for new.example.com failed; refusing https://new.example.com/hook (fail-closed SSRF guard).",
    });
    const field = document.getElementById("webhookUrl") as HTMLInputElement;
    field.value = "https://new.example.com/hook";
    expect(await mod.saveSettings()).toBe(true);
    // The configured webhook must not silently disappear after a DNS hiccup.
    expect(localStore.get("webhookUrl")).toBe("https://old.example.com/hook");
    expect(field.value).toBe("https://new.example.com/hook");
  });

  test("syntactic rejection still clears the field and persists empty", async () => {
    setupGlobals();
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    webhookResolveMock.mockClear();
    webhookResolveMock.mockResolvedValueOnce({ ok: false, reason: "scheme \"ftp\" is not allowed (only http/https)" });
    const field = document.getElementById("webhookUrl") as HTMLInputElement;
    field.value = "ftp://x";
    const savePromise = mod.saveSettings();
    // The invalid-value alert blocks the save until dismissed; Esc closes it.
    // The overlay only appears after the (async) webhook check resolves, so
    // wait for it before dispatching Escape — otherwise the keydown hits
    // nothing and the alert promise never settles.
    await vi.waitFor(() => {
      expect(document.querySelector(".modal-overlay")).not.toBeNull();
    });
    document.querySelector(".modal-overlay")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await savePromise).toBe(true);
    expect(localStore.get("webhookUrl")).toBe("");
    expect(field.value).toBe("");
  });

  test("validation verdict is cached per URL (no DNS round-trip per autosave)", async () => {
    setupGlobals();
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    webhookResolveMock.mockClear();
    webhookResolveMock.mockResolvedValue({ ok: true });
    const field = document.getElementById("webhookUrl") as HTMLInputElement;
    field.value = "https://valid.example.com/hook";
    await mod.saveSettings();
    await mod.saveSettings();
    expect(localStore.get("webhookUrl")).toBe("https://valid.example.com/hook");
    expect(webhookResolveMock).toHaveBeenCalledTimes(1);
  });
});

describe("agentMode/maxSteps change tracking", () => {
  test("an unrelated save does not re-write agentMode/maxSteps (sidepanel change preserved)", async () => {
    setupGlobals();
    localStore.set("agentMode", "full");
    localStore.set("maxSteps", 42);
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    // The sidepanel writes after Options loaded; the form still holds the
    // page-load values.
    localStore.set("agentMode", "agent");
    localStore.set("maxSteps", 7);
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.get("agentMode")).toBe("agent");
    expect(localStore.get("maxSteps")).toBe(7);
  });

  test("changing the maxSteps control persists the new value", async () => {
    setupGlobals();
    localStore.set("maxSteps", 42);
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    const steps = document.getElementById("maxSteps") as HTMLInputElement;
    steps.value = "7";
    steps.dispatchEvent(new Event("input"));
    await mod.saveSettings();
    expect(localStore.get("maxSteps")).toBe(7);
  });
});

/**
 * O1 — the Options reasoning controls round-trip through saveSettings/load.
 * llm-direct.ts reads these exact top-level keys (getReasoningEffort /
 * getReasoningBudget / getForceReasoning), so a regression dropping them from
 * the save path would silently reset user reasoning configuration.
 */
describe("settings-sync reasoning (O1) round-trip", () => {
  test("saveSettings persists effort/budget/force with sanctioned values", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    (document.getElementById("reasoningEffort") as HTMLSelectElement).value = "high";
    (document.getElementById("reasoningBudget") as HTMLInputElement).value = "20480";
    (document.getElementById("forceReasoning") as HTMLSelectElement).value = "off";
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.get("reasoningEffort")).toBe("high");
    expect(localStore.get("reasoningBudget")).toBe(20480);
    expect(localStore.get("forceReasoning")).toBe("off");
  });

  test("an emptied budget field removes the previously-stored budget", async () => {
    setupGlobals();
    localStore.set("reasoningBudget", 1024);
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    (document.getElementById("reasoningBudget") as HTMLInputElement).value = "";
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.has("reasoningBudget")).toBe(false);
  });

  test("a tampered effort/force value falls back to the default instead of persisting junk", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    // populateReasoningControls rebuilds the effort select, so an out-of-set
    // value can only come from tampering — the save path must guard it.
    (document.getElementById("reasoningEffort") as HTMLSelectElement).value = "xhigh";
    (document.getElementById("forceReasoning") as HTMLSelectElement).value = "sometimes";
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.get("reasoningEffort")).toBe("medium");
    expect(localStore.get("forceReasoning")).toBe("auto");
  });

  test("import-time load reflects restored reasoning settings", async () => {
    setupGlobals();
    localStore.set("reasoningEffort", "high");
    localStore.set("reasoningBudget", 20480);
    localStore.set("forceReasoning", "off");
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    expect((document.getElementById("reasoningEffort") as HTMLSelectElement).value).toBe("high");
    expect((document.getElementById("reasoningBudget") as HTMLInputElement).value).toBe("20480");
    expect((document.getElementById("forceReasoning") as HTMLSelectElement).value).toBe("off");
  });
});

/**
 * Context-override (tokens) round-trip. llm-direct.ts reads the top-level
 * `contextTokens` key (getContextTokens) to derive per-kind prompt budgets for
 * models whose catalog `limit.context` differs from what the user can actually
 * run — a regression dropping it from the save path would silently ignore the
 * user's "256k native, but I run at 64k" cap.
 */
describe("settings-sync context override round-trip", () => {
  test("saveSettings persists a valid override", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    (document.getElementById("contextTokens") as HTMLInputElement).value = "64000";
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.get("contextTokens")).toBe(64_000);
  });

  test("an emptied field removes the previously-stored override", async () => {
    setupGlobals();
    localStore.set("contextTokens", 64_000);
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    (document.getElementById("contextTokens") as HTMLInputElement).value = "";
    expect(await mod.saveSettings()).toBe(true);
    expect(localStore.has("contextTokens")).toBe(false);
  });

  test("an out-of-range value resets the field and stores nothing", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    (document.getElementById("contextTokens") as HTMLInputElement).value = "42";
    expect(await mod.saveSettings()).toBe(true);
    expect((document.getElementById("contextTokens") as HTMLInputElement).value).toBe("");
    expect(localStore.has("contextTokens")).toBe(false);
  });

  test("import-time load reflects a stored override", async () => {
    setupGlobals();
    localStore.set("contextTokens", 64_000);
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    expect((document.getElementById("contextTokens") as HTMLInputElement).value).toBe("64000");
  });
});

/**
 * O8 — the provider-scoped config record written by the Options save path.
 * The active provider's entry mirrors the flat values; other providers' entries
 * survive untouched so switching providers restores their config.
 */
describe("settings-sync providerConfigs (O8) write + load", () => {
  test("saveSettings writes a nested record mirroring the flat values", async () => {
    setupGlobals();
    const mod = await import("../src/extension/options/settings-sync");
    const providerId = activeProviderId();
    (document.getElementById("model") as HTMLInputElement).value = "gpt-5.5";
    (document.getElementById("baseUrl") as HTMLInputElement).value = "https://custom.example.com/v1";
    (document.getElementById("resourceName") as HTMLInputElement).value = "my-resource";
    expect(await mod.saveSettings()).toBe(true);
    const record = localStore.get("providerConfigs") as Record<string, unknown>;
    expect(record[providerId]).toEqual({
      model: "gpt-5.5",
      baseUrl: "https://custom.example.com/v1",
      resourceName: "my-resource",
      provenance: "user",
    });
  });

  test("saveSettings preserves other providers' nested entries", async () => {
    setupGlobals();
    localStore.set("providerConfigs", {
      anthropic: { model: "claude-old", baseUrl: "https://legacy.example.com", resourceName: "", provenance: "user" },
    });
    vi.resetModules();
    const mod = await import("../src/extension/options/settings-sync");
    const providerId = activeProviderId();
    (document.getElementById("model") as HTMLInputElement).value = "gpt-5.5";
    expect(await mod.saveSettings()).toBe(true);
    const record = localStore.get("providerConfigs") as Record<string, unknown>;
    expect(record.anthropic).toEqual({
      model: "claude-old",
      baseUrl: "https://legacy.example.com",
      resourceName: "",
      provenance: "user",
    });
    expect(record[providerId]).toBeDefined();
  });

  test("import-time load applies the nested record over the flat mirror", async () => {
    setupGlobals();
    localStore.set("provider", "openai");
    localStore.set("model", "flat-model");
    localStore.set("baseUrl", "https://flat.example.com");
    localStore.set("resourceName", "flat-res");
    localStore.set("providerConfigs", {
      openai: {
        model: "nested-model",
        baseUrl: "https://nested.example.com",
        resourceName: "nested-res",
        provenance: "user",
      },
    });
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    expect((document.getElementById("model") as HTMLInputElement).value).toBe("nested-model");
    expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("https://nested.example.com");
    expect((document.getElementById("resourceName") as HTMLInputElement).value).toBe("nested-res");
  });

  test("import-time load falls back to the flat mirror when the provider has no nested entry", async () => {
    setupGlobals();
    localStore.set("provider", "openai");
    localStore.set("model", "flat-model");
    localStore.set("baseUrl", "https://flat.example.com");
    vi.resetModules();
    await import("../src/extension/options/settings-sync");
    expect((document.getElementById("model") as HTMLInputElement).value).toBe("flat-model");
    expect((document.getElementById("baseUrl") as HTMLInputElement).value).toBe("https://flat.example.com");
  });
});
