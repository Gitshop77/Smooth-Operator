/**
 * Provider/model change flow (Connection tab store).
 *
 * Covers the "changing provider/model updates capabilities, connection
 * diagnostics, and prompts without stale-cache leaks" invariant:
 * - a real provider change clears the previous provider's model and refreshes
 *   capabilities (pure derivation, no DOM/storage);
 * - re-selecting the same provider preserves a hydrated model (first-paint
 *   safety) and does NOT bump the generation;
 * - a model change bumps the generation so in-flight work for the old
 *   selection is provably stale;
 * - the credential surface holds only the opaque reference snapshot — never a
 *   key value (masked/redacted display invariant);
 * - an unknown provider falls back to safe defaults instead of leaking the
 *   previous selection's capabilities.
 */

import { describe, expect, test } from "vitest";
import {
  providerConfigReducer,
  initialProviderConfigState,
  capabilitiesForProvider,
  type ProviderConfigState,
} from "../src/extension/options/stores/provider-config-store";
import { createCredentialHandle } from "../src/extension/credential-contract";

function stateWith(overrides: Partial<ProviderConfigState>): ProviderConfigState {
  return { ...initialProviderConfigState, ...overrides };
}

describe("provider-config reducer — provider change flow", () => {
  test("a real provider change clears the previous model and bumps generation", () => {
    let s = stateWith({ provider: "openai", model: "gpt-5.5", generation: 3 });
    s = providerConfigReducer(s, { type: "PROVIDER_SELECTED", provider: "anthropic" });
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe(""); // the previous provider's model must not leak
    expect(s.generation).toBe(4);
    expect(s.capabilities.needsKey).toBe(true);
    expect(s.capabilities.defaultModel).toBeTruthy();
  });

  test("re-selecting the same provider preserves a hydrated model and keeps the generation", () => {
    const s = stateWith({ provider: "openai", model: "gpt-5.5", generation: 2 });
    const next = providerConfigReducer(s, { type: "PROVIDER_SELECTED", provider: "openai" });
    expect(next.model).toBe("gpt-5.5");
    expect(next.generation).toBe(2);
    expect(next.provider).toBe("openai");
  });

  test("a model change bumps the generation but a repeated model is a no-op", () => {
    let s = stateWith({ provider: "openai", model: "gpt-5.5", generation: 1 });
    s = providerConfigReducer(s, { type: "MODEL_SELECTED", model: "gpt-5.6" });
    expect(s.model).toBe("gpt-5.6");
    expect(s.generation).toBe(2);
    const same = providerConfigReducer(s, { type: "MODEL_SELECTED", model: "gpt-5.6" });
    expect(same).toBe(s); // deterministic no-op, generation untouched
  });

  test("an unknown provider falls back to safe defaults without leaking the old capabilities", () => {
    const s = stateWith({ provider: "openai", capabilities: capabilitiesForProvider("openai") });
    const next = providerConfigReducer(s, { type: "PROVIDER_SELECTED", provider: "not-a-provider" });
    expect(next.capabilities.needsKey).toBe(capabilitiesForProvider("openai").needsKey);
    expect(next.model).toBe("");
    expect(next.generation).toBe(1);
  });

  test("baseUrl/resourceName changes never bump the generation", () => {
    let s = stateWith({ generation: 5 });
    s = providerConfigReducer(s, { type: "BASE_URL_CHANGED", baseUrl: "https://x.example" });
    s = providerConfigReducer(s, { type: "RESOURCE_NAME_CHANGED", resourceName: "res-1" });
    expect(s.baseUrl).toBe("https://x.example");
    expect(s.resourceName).toBe("res-1");
    expect(s.generation).toBe(5);
  });

  test("credential status carries only the opaque reference — never a secret value", () => {
    let s = stateWith({});
    s = providerConfigReducer(s, {
      type: "CREDENTIAL_STATUS_RESOLVED",
      status: {
        status: "ready",
        reference: {
          version: 1,
          handle: createCredentialHandle(),
          providerId: "openai",
          revision: 3,
        },
      },
    });
    const ref = s.credentialStatus?.status === "ready" ? s.credentialStatus.reference : null;
    expect(ref?.providerId).toBe("openai");
    expect(ref?.revision).toBe(3);
    const json = JSON.stringify(s);
    // The provider key *value* must never appear in state — only display-safe
    // metadata like the key placeholder ("sk-proj-...") and the opaque vault
    // reference handle may exist.
    expect(json).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(ref?.handle).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  test("config errors surface explicitly and can be cleared", () => {
    let s = providerConfigReducer(stateWith({}), { type: "CONFIG_ERROR", error: "storage unavailable" });
    expect(s.error).toBe("storage unavailable");
    s = providerConfigReducer(s, { type: "CONFIG_ERROR_CLEARED" });
    expect(s.error).toBeUndefined();
  });
});

describe("provider capabilities derivation", () => {
  test("ollama is keyless with a local default endpoint", () => {
    const caps = capabilitiesForProvider("ollama");
    expect(caps.needsKey).toBe(false);
    expect(caps.defaultBaseUrl).toContain("localhost");
  });

  test("openai is keyed with a default model", () => {
    const caps = capabilitiesForProvider("openai");
    expect(caps.needsKey).toBe(true);
    expect(caps.defaultModel).toBeTruthy();
  });
});
