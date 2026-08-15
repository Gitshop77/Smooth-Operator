// tests/lightpanda-provider-mapping.test.ts
import { describe, it, expect } from "vitest";
import {
  buildLightpandaLaunch,
  type ProviderConfigLike,
} from "../src/lib/agent/lightpanda/provider-mapping";

describe("buildLightpandaLaunch", () => {
  it("maps openai", () => {
    const r = buildLightpandaLaunch({ provider: "openai", apiKey: "k", model: "gpt-5" });
    expect(r).toEqual({ ok: true, launch: { provider: "openai", model: "gpt-5", env: { OPENAI_API_KEY: "k" } } });
  });
  it("maps anthropic", () => {
    const r = buildLightpandaLaunch({ provider: "anthropic", apiKey: "k" });
    expect(r).toEqual({ ok: true, launch: { provider: "anthropic", env: { ANTHROPIC_API_KEY: "k" } } });
  });
  it("maps gemini", () => {
    const r = buildLightpandaLaunch({ provider: "gemini", apiKey: "k" });
    expect(r).toEqual({ ok: true, launch: { provider: "gemini", env: { GEMINI_API_KEY: "k" } } });
  });
  it("maps xai to openai_compatible with its base URL and OPENAI_BASE_URL", () => {
    const r = buildLightpandaLaunch({ provider: "xai", apiKey: "k" });
    expect(r).toEqual({
      ok: true,
      launch: { provider: "openai_compatible", baseUrl: "https://api.x.ai/v1", env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.x.ai/v1" } },
    });
  });
  it("maps openrouter to openai_compatible with its base URL and OPENAI_BASE_URL", () => {
    const r = buildLightpandaLaunch({ provider: "openrouter", apiKey: "k" });
    expect(r).toEqual({
      ok: true,
      launch: { provider: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://openrouter.ai/api/v1" } },
    });
  });
  it("maps azure using the configured base URL", () => {
    const r = buildLightpandaLaunch({ provider: "azure", apiKey: "k", baseUrl: "https://x.openai.azure.com/openai/v1", model: "gpt-5" });
    expect(r).toEqual({
      ok: true,
      launch: { provider: "openai_compatible", baseUrl: "https://x.openai.azure.com/openai/v1", model: "gpt-5", env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://x.openai.azure.com/openai/v1" } },
    });
  });
  it("synthesizes the azure base URL from resourceName", () => {
    const r = buildLightpandaLaunch({ provider: "azure", apiKey: "k", resourceName: "myres" });
    expect(r.ok && r.launch.baseUrl).toBe("https://myres.openai.azure.com/openai/v1");
    expect(r.ok && r.launch.env.OPENAI_BASE_URL).toBe("https://myres.openai.azure.com/openai/v1");
  });
  it("maps ollama without an API key (harness stores apiKey '')", () => {
    const r = buildLightpandaLaunch({ provider: "ollama", model: "llama3.3", apiKey: "" });
    expect(r).toEqual({ ok: true, launch: { provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.3", env: {} } });
  });
  it("maps mistral to the dedicated lightpanda mistral provider", () => {
    const r = buildLightpandaLaunch({ provider: "mistral", apiKey: "k" });
    expect(r).toEqual({ ok: true, launch: { provider: "mistral", env: { MISTRAL_API_KEY: "k" } } });
  });
  it("maps profile-table providers (deepseek) with their default base URL", () => {
    const r = buildLightpandaLaunch({ provider: "deepseek", apiKey: "k" });
    expect(r).toEqual({
      ok: true,
      launch: { provider: "openai_compatible", baseUrl: "https://api.deepseek.com", env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.deepseek.com" } },
    });
  });
  it("maps groq from the profile table", () => {
    const r = buildLightpandaLaunch({ provider: "groq", apiKey: "k" });
    expect(r.ok && r.launch.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(r.ok && r.launch.env).toEqual({ OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.groq.com/openai/v1" });
  });
  it("maps litellm without an API key (local proxy)", () => {
    const r = buildLightpandaLaunch({ provider: "litellm" });
    expect(r).toEqual({
      ok: true,
      launch: { provider: "openai_compatible", baseUrl: "http://localhost:4000/v1", env: { OPENAI_BASE_URL: "http://localhost:4000/v1" } },
    });
  });
  it("maps google (Vertex AI) via the openai_compatible fallback with its user base URL", () => {
    const r = buildLightpandaLaunch({ provider: "google", apiKey: "k", baseUrl: "https://vertex.example.test/v1" });
    expect(r).toEqual({
      ok: true,
      launch: { provider: "openai_compatible", baseUrl: "https://vertex.example.test/v1", env: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://vertex.example.test/v1" } },
    });
  });
  it("rejects google without a base URL (Vertex has no static endpoint)", () => {
    expect(buildLightpandaLaunch({ provider: "google", apiKey: "k" }).ok).toBe(false);
  });
  it("rejects unknown providers without a baseUrl", () => {
    const r = buildLightpandaLaunch({ provider: "mystery", apiKey: "k" });
    expect(r.ok).toBe(false);
  });
  it("rejects missing apiKey", () => {
    const r = buildLightpandaLaunch({ provider: "openai" });
    expect(r.ok).toBe(false);
  });
  it("rejects missing provider", () => {
    expect(buildLightpandaLaunch({} as ProviderConfigLike).ok).toBe(false);
  });
});
