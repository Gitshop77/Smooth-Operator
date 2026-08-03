/**
 * Regression tests for the provider fixes:
 *
 * - The OpenCode Zen/Go *default* base URL is the API base
 *   (`https://opencode.ai/zen/v1`, …) — the `/chat/completions` suffix is
 *   appended by the runtime facade, so committing the suffixed endpoint into
 *   the `baseUrl` field produced a doubled path (`…/chat/completions/chat/
 *   completions`) and a 404 on Test Connection.
 * - The options-side canonical-host check must mirror `buildProvider`'s
 *   `canonicalLlmHost` — `null` for tail (catalog-derived) providers, never a
 *   host invented from the catalog `api` URL, and `null` means REJECT (the
 *   runtime computes `allowed = canon !== null && …`).
 *
 * `provider-config-ui.ts` runs DOM side-effects at import time, so the minimal
 * element set is created before the dynamic imports (mirroring
 * `provider-config-ui.test.ts`).
 */

import { describe, test, expect, beforeAll } from "vitest";

function setupDom(): void {
  document.body.innerHTML = `
    <select id="provider">
      <option value="openai">OpenAI</option>
      <option value="opencode">OpenCode Zen</option>
      <option value="opencode-go">OpenCode Go</option>
      <option value="nvidia">NVIDIA</option>
    </select>
    <button id="testConnection"></button>
    <input id="model">
    <span id="provider-hint"></span>
    <input id="apiKey">
    <span id="apikey-hint"></span>
    <label id="baseurl-label"></label>
    <input id="baseUrl">
    <label id="resourcename-label"></label>
    <input id="resourceName">
    <div id="opencode-endpoint-hint"></div>
  `;
}

describe("options provider fixes", () => {
  let checkCanonicalHost: (
    provider: string,
    url: string,
    apiKey: string,
  ) => string | null;
  let updateOpencodeEndpointHint: (tier: "zen" | "go") => void;
  let updateProviderUI: () => void;

  beforeAll(async () => {
    setupDom();
    const utils = await import("../src/extension/options/connection-test-utils");
    const uiUtils = await import("../src/extension/options/provider-config-ui-utils");
    const ui = await import("../src/extension/options/provider-config-ui");
    checkCanonicalHost = utils.checkCanonicalHost;
    updateOpencodeEndpointHint = uiUtils.updateOpencodeEndpointHint;
    updateProviderUI = ui.updateProviderUI;
  });

  describe("OpenCode Zen/Go baseUrl default is the API base", () => {
    test("provider change to opencode commits the base URL (no /chat/completions)", () => {
      const provider = document.getElementById("provider") as HTMLSelectElement;
      const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
      provider.value = "openai";
      updateProviderUI();
      provider.value = "opencode";
      updateProviderUI();
      expect(baseUrl.value).toBe("https://opencode.ai/zen/v1");
      expect(baseUrl.value).not.toContain("/chat/completions");
    });

    test("provider change to opencode-go commits the go base URL", () => {
      const provider = document.getElementById("provider") as HTMLSelectElement;
      const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
      provider.value = "opencode-go";
      updateProviderUI();
      expect(baseUrl.value).toBe("https://opencode.ai/zen/go/v1");
    });

    test("endpoint hint auto-fill writes the BASE into an empty baseUrl field", () => {
      const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
      baseUrl.value = "";
      updateOpencodeEndpointHint("zen");
      expect(baseUrl.value).toBe("https://opencode.ai/zen/v1");
      expect(baseUrl.value).not.toContain("/chat/completions");
    });

    test("endpoint hint auto-fill for the go tier writes the go base", () => {
      const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
      baseUrl.value = "";
      updateOpencodeEndpointHint("go");
      expect(baseUrl.value).toBe("https://opencode.ai/zen/go/v1");
    });

    test("endpoint hint still surfaces the full /chat/completions endpoint", () => {
      updateOpencodeEndpointHint("zen");
      const hint = document.getElementById("opencode-endpoint-hint");
      expect(hint?.textContent).toContain("https://opencode.ai/zen/v1/chat/completions");
    });

    test("endpoint hint never overwrites a user-entered baseUrl", () => {
      const baseUrl = document.getElementById("baseUrl") as HTMLInputElement;
      baseUrl.value = "https://example.com/custom";
      updateOpencodeEndpointHint("zen");
      expect(baseUrl.value).toBe("https://example.com/custom");
    });
  });

  describe("Canonical-host check mirrors buildProvider", () => {
    test("tail (catalog-derived) provider: no canonical host means reject (runtime parity)", () => {
      // "nvidia" is a catalog-derived provider with no runtime profile entry,
      // so buildProvider's canonicalLlmHost returns null. The runtime computes
      // `allowed = canon !== null && …` — null rejects — and the options-side
      // check must mirror that instead of inventing a canonical host from the
      // catalog api URL.
      const err = checkCanonicalHost("nvidia", "https://evil.example.com/v1", "sk-x");
      expect(err).not.toBeNull();
      expect(err).toContain("canonical host");
    });

    test("tail provider rejects even its catalog api URL", () => {
      const err = checkCanonicalHost(
        "nvidia",
        "https://integrate.api.nvidia.com/v1",
        "sk-x",
      );
      expect(err).not.toBeNull();
      expect(err).toContain("canonical host");
    });

    test("opencode-go (featured, runtime-confined) still rejects a foreign host", () => {
      const err = checkCanonicalHost("opencode-go", "https://evil.example.com/v1", "sk-x");
      expect(err).not.toBeNull();
      expect(err).toContain("canonical host");
    });

    test("opencode accepts its own host", () => {
      expect(
        checkCanonicalHost("opencode", "https://opencode.ai/zen/v1", "sk-x"),
      ).toBeNull();
    });

    test("opencode rejects a foreign host", () => {
      const err = checkCanonicalHost("opencode", "https://evil.example.com/v1", "sk-x");
      expect(err).not.toBeNull();
    });

    test("no key → no confinement regardless of provider", () => {
      expect(
        checkCanonicalHost("opencode-go", "https://evil.example.com/v1", ""),
      ).toBeNull();
    });

    test("suffix confinement requires a DOTTED subdomain boundary", () => {
      // "evilgoogleapis.com" ENDS WITH "googleapis.com" but is not a
      // subdomain — a boundary-less endsWith would let an attacker host that
      // merely shares the suffix receive the user's API key.
      const err = checkCanonicalHost("google", "https://evilgoogleapis.com/v1", "sk-x");
      expect(err).not.toBeNull();
      expect(err).toContain("canonical host");
    });

    test("suffix confinement rejects a bare-suffix-anchored host for anthropic", () => {
      const err = checkCanonicalHost("anthropic", "https://evilanthropic.com/v1", "sk-x");
      expect(err).not.toBeNull();
      expect(err).toContain("canonical host");
    });

    test("suffix confinement still allows real subdomains", () => {
      expect(
        checkCanonicalHost("google", "https://generativelanguage.googleapis.com/v1", "sk-x"),
      ).toBeNull();
      expect(
        checkCanonicalHost("anthropic", "https://api.anthropic.com/v1", "sk-x"),
      ).toBeNull();
    });

    test("suffix confinement accepts the exact canonical host (mirrors runtime)", () => {
      // The runtime guard (provider-config.ts) accepts `host === canon.host`
      // for suffix providers too — the options check must not reject it.
      expect(
        checkCanonicalHost("anthropic", "https://anthropic.com/v1", "sk-x"),
      ).toBeNull();
      expect(
        checkCanonicalHost("google", "https://googleapis.com/v1", "sk-x"),
      ).toBeNull();
      expect(
        checkCanonicalHost("azure", "https://openai.azure.com/openai/v1", "sk-x"),
      ).toBeNull();
    });

    test("azure per-resource host is allowed", () => {
      expect(
        checkCanonicalHost("azure", "https://my-resource.openai.azure.com/openai/v1", "sk-x"),
      ).toBeNull();
    });

    test("azure rejects a host that merely ends with the canonical domain", () => {
      const err = checkCanonicalHost("azure", "https://openai.azure.com.evil.com/openai/v1", "sk-x");
      expect(err).not.toBeNull();
    });
  });
});
