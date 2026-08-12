/**
 * Tests for the models.dev catalog (`src/lib/agent/llm/catalog.ts`,
 * `@opencode-ai/models/snapshot`) and the per-provider connection tester
 * (`src/extension/options/connection-test.ts`).
 *
 * Run with: `npx vitest run tests/catalog.test.ts`
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getProviders,
  getModelsForProvider,
  getDefaultModelForProvider,
  isValidCatalog,
  catalogIdMatches,
  fetchCatalog,
  scheduleRefresh,
  __resetCatalogForTests,
} from "../src/lib/agent/llm/catalog";
import { providers as BUNDLED_CATALOG } from "@opencode-ai/models/snapshot";
import { mergeCatalogs, CACHE_TTL_MS, reasoningOptionsFor, type CatalogModel, type CatalogProvider, type Catalog } from "../src/lib/agent/llm/catalog-data";
import { DEFAULT_MODELS } from "../src/extension/provider-config";
import { testProviderConnection } from "../src/extension/options/connection-test";

// The connection test runs the project SSRF guard (`resolveAndValidateLlmBaseUrl`)
// before each fetch. In a Node/vitest context that guard would attempt real DNS
// resolution of public hostnames, making the test network-dependent and flaky.
// We stub it to always pass so the test exercises ONLY the fetch/shape logic —
// the SSRF guard itself is covered by dedicated tests elsewhere (ssrf,
// openrouter, provider-config-ssrf, ...).
vi.mock("../src/lib/agent/llm/route/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agent/llm/route/ssrf")>();
  return {
    ...actual,
    resolveAndValidateLlmBaseUrl: vi.fn(async () => ({ ok: true })),
  };
});

describe("catalog bundle integrity", () => {
  // Resolve each named provider to its models.dev catalog id (mirrors
  // CATALOG_PROVIDER_ID_MAP in provider-config-map.ts). These are the catalog
  // keys the bundle is expected to contain for the spot-checked providers.
  const SPOT_CHECK: Record<string, string> = {
    openai: "openai",
    anthropic: "anthropic",
    google: "google",
    togetherai: "togetherai",
    deepseek: "deepseek",
    openrouter: "openrouter",
    xai: "xai",
    groq: "groq",
    mistral: "mistral",
    cerebras: "cerebras",
    opencode: "opencode",
    azure: "openai", // Azure surfaces OpenAI's catalog
    // The following named providers are NOT present as catalog provider keys in
    // the bundle — flagged, not asserted (see test below):
    //   dashscope -> "dashscope": ABSENT (bundle has no dashscope/qwen provider)
    //   ollama    -> "ollama":    ABSENT (only "ollama-cloud" is present)
    //   litellm   -> "litellm":   ABSENT
  };
  const EXPECTED_KEYS = Object.values(SPOT_CHECK);

  test("getProviders() returns at least 167 providers", () => {
    expect(getProviders().length).toBeGreaterThanOrEqual(167);
  });

  test("BUNDLED_CATALOG exposes the expected known provider keys", () => {
    for (const id of EXPECTED_KEYS) {
      expect(BUNDLED_CATALOG, `missing provider ${id}`).toHaveProperty(id);
      expect(typeof BUNDLED_CATALOG[id].id).toBe("string");
      expect(typeof BUNDLED_CATALOG[id].name).toBe("string");
      expect(BUNDLED_CATALOG[id].models).toBeTypeOf("object");
    }
  });

  test("gateway/local providers are intentionally absent from the catalog", () => {
    // These are real providers we support, but they are NOT models.dev catalog
    // provider ids — dashscope is aliased to a qwen provider that the bundle
    // does not include, ollama/litellm are local/gateway servers. The catalog
    // engine falls back to heuristics for them. We pin this so a regression
    // that wrongly injects them is caught.
    expect(BUNDLED_CATALOG).not.toHaveProperty("dashscope");
    expect(BUNDLED_CATALOG).not.toHaveProperty("ollama");
    expect(BUNDLED_CATALOG).not.toHaveProperty("litellm");
  });

  test("provider ids from getProviders match BUNDLED_CATALOG keys", () => {
    const fromGet = getProviders().map((p) => p.id).sort();
    const fromBundled = Object.keys(BUNDLED_CATALOG).sort();
    expect(fromGet).toEqual(fromBundled);
  });

  test("getProviders returns bundled provider entries with intact identity", () => {
    // The load-time merge is a shallow spread of BUNDLED_CATALOG, so the
    // accessor path must hand back the same provider set with the same
    // identity fields and model tables. This pins the accessor pipeline: a
    // future getProviders that re-builds provider objects (wrong name, wrong
    // model table, dropped/renamed ids) fails here.
    const fromGet = getProviders();
    for (const p of fromGet) {
      const bundled = BUNDLED_CATALOG[p.id];
      expect(bundled, `no bundled entry for ${p.id}`).toBeDefined();
      expect(p.id).toBe(bundled.id);
      expect(p.name).toBe(bundled.name);
      expect(Object.keys(p.models).sort()).toEqual(Object.keys(bundled.models).sort());
    }
    // Spot-check the accessor path returns the same model objects the bundle
    // exposes (a re-built models table with the same keys but new objects
    // would be invisible to the key-set check above).
    for (const pid of ["openai", "anthropic"]) {
      for (const m of getModelsForProvider(pid)) {
        expect(BUNDLED_CATALOG[pid].models[m.id]).toBe(m);
      }
    }
  });
});

describe("mergeCatalogs — live-over-base additive merge", () => {
  function model(id: string, name = `Model ${id}`): CatalogModel {
    return {
      id,
      name,
      release_date: "2024-01-01",
      attachment: false,
      reasoning: false,
      tool_call: true,
      cost: { input: 1, output: 2 },
    };
  }

  function provider(id: string, models: Record<string, CatalogModel>, name = `Provider ${id}`): CatalogProvider {
    return { id, name, models };
  }

  test("live wins for overlapping provider ids (fields and models)", () => {
    const base = {
      p: provider("p", { a: model("a"), b: model("b") }, "Base P"),
    };
    const live = {
      p: provider("p", { b: model("b", "Live B"), c: model("c") }, "Live P"),
    };
    const merged = mergeCatalogs(base, live);
    expect(merged.p.name).toBe("Live P"); // provider fields: live wins
    expect(Object.keys(merged.p.models).sort()).toEqual(["a", "b", "c"]); // base models never dropped
    expect(merged.p.models.a).toBe(base.p.models.a); // untouched base model kept
    expect(merged.p.models.b.name).toBe("Live B"); // overlapping model: live wins
    expect(merged.p.models.c.id).toBe("c"); // new model appended
  });

  test("bundled providers are never dropped by a live catalog", () => {
    const base = {
      p1: provider("p1", { a: model("a") }),
      p2: provider("p2", { x: model("x") }),
    };
    const merged = mergeCatalogs(base, {
      p1: provider("p1", { b: model("b") }, "Live P1"),
    });
    expect(Object.keys(merged).sort()).toEqual(["p1", "p2"]);
    expect(merged.p2).toEqual(base.p2); // untouched provider carried through with intact data
  });

  test("new providers are appended", () => {
    const base = { p1: provider("p1", { a: model("a") }) };
    const merged = mergeCatalogs(base, {
      p2: provider("p2", { z: model("z") }, "Live P2"),
    });
    expect(Object.keys(merged).sort()).toEqual(["p1", "p2"]);
    expect(merged.p2.name).toBe("Live P2");
    expect(merged.p2.models.z.id).toBe("z");
  });

  test("inputs are not mutated and the merged catalog is frozen", () => {
    const base = { p: provider("p", { a: model("a") }) };
    const live = { p: provider("p", { b: model("b") }, "Live P") };
    const baseSnapshot = JSON.stringify(base);
    const liveSnapshot = JSON.stringify(live);
    const merged = mergeCatalogs(base, live);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(live)).toBe(liveSnapshot);
  });
});

describe("no hyphenated OpenRouter claude ids", () => {
  test("DEFAULT_MODELS.openrouter uses dots, not hyphens", () => {
    expect(DEFAULT_MODELS.openrouter).toBe("anthropic/claude-sonnet-5");
  });

  test("OpenRouter claude ids use dots (3.5), never hyphens (3-5)", () => {
    const bad: string[] = [];
    const openrouter = BUNDLED_CATALOG.openrouter;
    if (openrouter?.models) {
      for (const mid of Object.keys(openrouter.models)) {
        if (/claude.*3-5/.test(mid)) bad.push(mid);
      }
    }
    expect(bad, `openrouter claude ids still use hyphens: ${bad.join(", ")}`).toEqual([]);
  });
});

describe("every model has numeric cost (documents known gaps)", () => {
  // models.dev legitimately omits pricing for some models — mostly image/
  // audio/embedding/gateway models and preview entries. Rather than force the
  // whole suite red on legitimate data, we pin the EXACT set of cost-less model
  // ids as a baseline. If the bundle regenerates and pricing changes (a provider
  // silently dropping cost, or a new provider without pricing), this assertion
  // flags it loudly instead of silently passing.
  //
  // REFRESHING after `npm update` (which regenerates the @opencode-ai/models
  // snapshot): run this file; the divergence warning prints the exact
  // `added` / `removed` id lists. Copy the "added" ids into this baseline and
  // delete the "removed" ids, then re-run until green.
  const KNOWN_MISSING_COST = [
    "anyapi/anthropic/claude-haiku-4-5",
    "anyapi/anthropic/claude-opus-4-6",
    "anyapi/anthropic/claude-opus-4-7",
    "anyapi/anthropic/claude-sonnet-4-5",
    "anyapi/anthropic/claude-sonnet-4-6",
    "anyapi/cohere/command-r-plus-08-2024",
    "anyapi/deepseek/deepseek-chat",
    "anyapi/deepseek/deepseek-r1",
    "anyapi/deepseek/deepseek-v4-flash",
    "anyapi/deepseek/deepseek-v4-pro",
    "anyapi/google/gemini-2.5-flash",
    "anyapi/google/gemini-2.5-flash-lite",
    "anyapi/google/gemini-2.5-pro",
    "anyapi/google/gemini-3-flash-preview",
    "anyapi/google/gemini-3-pro-preview",
    "anyapi/mistralai/devstral-2512",
    "anyapi/mistralai/mistral-large-2512",
    "anyapi/openai/gpt-4.1",
    "anyapi/openai/gpt-4.1-mini",
    "anyapi/openai/gpt-5",
    "anyapi/openai/gpt-5-mini",
    "anyapi/openai/gpt-5.1",
    "anyapi/openai/gpt-5.2",
    "anyapi/openai/gpt-5.4",
    "anyapi/openai/o3",
    "anyapi/openai/o3-mini",
    "anyapi/openai/o4-mini",
    "anyapi/perplexity/sonar-pro",
    "anyapi/perplexity/sonar-reasoning-pro",
    "anyapi/xai/grok-4.3",
    "blueclaw/Qwen/Qwen3.6-35B-A3B-FP8",
    "blueclaw/Qwen3.6-27B",
    "cohere/c4ai-aya-expanse-32b",
    "cohere/c4ai-aya-expanse-8b",
    "cohere/c4ai-aya-vision-32b",
    "cohere/c4ai-aya-vision-8b",
    "digitalocean/anthropic-claude-fable-5",
    "digitalocean/deepseek-4-flash",
    "digitalocean/deepseek-v3",
    "digitalocean/fal-ai/elevenlabs/tts/multilingual-v2",
    "digitalocean/fal-ai/fast-sdxl",
    "digitalocean/fal-ai/flux/schnell",
    "digitalocean/fal-ai/stable-audio-25/text-to-audio",
    "digitalocean/ministral-3-8b-instruct-2512",
    "digitalocean/mistral-7b-instruct-v0.3",
    "digitalocean/nemotron-3-nano-30b",
    "digitalocean/nemotron-3-ultra-550b",
    "digitalocean/openai-gpt-image-2",
    "digitalocean/qwen-2.5-14b-instruct",
    "digitalocean/qwen3-tts-voicedesign",
    "fastrouter/bytedance/seedance-2",
    "fastrouter/google/imagen-4.0-fast",
    "fastrouter/google/imagen-4.0-ultra",
    "fastrouter/google/veo3.1",
    "fastrouter/google/veo3.1-fast",
    "fastrouter/google/veo3.1-lite",
    "fastrouter/leonardo-ai/lucid-origin",
    "fastrouter/leonardo-ai/lucid-realism",
    "fastrouter/openai/gpt-image-2",
    "fastrouter/wanx/wan-v2-6",
    "google/gemma-4-26b-a4b-it",
    "google/gemma-4-31b-it",
    "google/veo-3.1-fast-generate-preview",
    "google/veo-3.1-generate-preview",
    "google/veo-3.1-lite-generate-preview",
    "groq/canopylabs/orpheus-arabic-saudi",
    "groq/canopylabs/orpheus-v1-english",
    "groq/groq/compound",
    "groq/groq/compound-mini",
    "groq/whisper-large-v3",
    "groq/whisper-large-v3-turbo",
    "merge-gateway/google/gemma-4-26b-a4b-it",
    "merge-gateway/google/gemma-4-31b-it",
    "model-oracle-ai/auto",
    "model-oracle-ai/claude-fable-5",
    "model-oracle-ai/claude-haiku-4.5",
    "model-oracle-ai/claude-opus-4.8",
    "model-oracle-ai/claude-sonnet-5",
    "model-oracle-ai/deepseek-v4-pro",
    "model-oracle-ai/glm-5.2",
    "model-oracle-ai/gpt-4.1",
    "model-oracle-ai/gpt-4.1-mini",
    "model-oracle-ai/gpt-5",
    "model-oracle-ai/gpt-5.4",
    "model-oracle-ai/gpt-5.4-mini",
    "model-oracle-ai/gpt-5.4-nano",
    "model-oracle-ai/gpt-5.5",
    "model-oracle-ai/o4-mini",
    "ollama-cloud/deepseek-v4-flash",
    "ollama-cloud/deepseek-v4-pro",
    "ollama-cloud/gemma4:31b",
    "ollama-cloud/glm-5.1",
    "ollama-cloud/glm-5.2",
    "ollama-cloud/gpt-oss:120b",
    "ollama-cloud/gpt-oss:20b",
    "ollama-cloud/kimi-k2.5",
    "ollama-cloud/kimi-k2.6",
    "ollama-cloud/kimi-k2.7-code",
    "ollama-cloud/kimi-k3",
    "ollama-cloud/minimax-m2.5",
    "ollama-cloud/minimax-m2.7",
    "ollama-cloud/minimax-m3",
    "ollama-cloud/mistral-large-3:675b",
    "ollama-cloud/nemotron-3-nano:30b",
    "ollama-cloud/nemotron-3-super",
    "ollama-cloud/nemotron-3-ultra",
    "ollama-cloud/qwen3.5:397b",
    "openai/chatgpt-image-latest",
    "openai/gpt-image-1",
    "openai/gpt-image-1-mini",
    "openai/gpt-image-1.5",
    "openrouter/openrouter/auto",
    "openrouter/openrouter/bodybuilder",
    "openrouter/openrouter/fusion",
    "openrouter/openrouter/pareto-code",
    "ovhcloud/qwen3guard-gen-0.6b",
    "ovhcloud/qwen3guard-gen-8b",
    "pioneer/pioneer/auto",
    "poe/cerebras/llama-3.3-70b-cs",
    "poe/cerebras/qwen3-235b-2507-cs",
    "poe/cerebras/qwen3-32b-cs",
    "poe/elevenlabs/elevenlabs-music",
    "poe/elevenlabs/elevenlabs-v2.5-turbo",
    "poe/elevenlabs/elevenlabs-v3",
    "poe/google/imagen-3",
    "poe/google/imagen-3-fast",
    "poe/google/imagen-4",
    "poe/google/imagen-4-fast",
    "poe/google/imagen-4-ultra",
    "poe/google/lyria",
    "poe/google/veo-2",
    "poe/google/veo-3",
    "poe/google/veo-3-fast",
    "poe/google/veo-3.1",
    "poe/google/veo-3.1-fast",
    "poe/ideogramai/ideogram",
    "poe/ideogramai/ideogram-v2",
    "poe/ideogramai/ideogram-v2a",
    "poe/ideogramai/ideogram-v2a-turbo",
    "poe/lumalabs/ray2",
    "poe/novita/glm-4.6",
    "poe/novita/glm-4.6v",
    "poe/novita/glm-4.7",
    "poe/novita/glm-4.7-flash",
    "poe/novita/glm-4.7-n",
    "poe/novita/kimi-k2-thinking",
    "poe/novita/minimax-m2.1",
    "poe/openai/dall-e-3",
    "poe/openai/gpt-4o",
    "poe/openai/gpt-image-1",
    "poe/openai/gpt-image-1-mini",
    "poe/openai/gpt-image-1.5",
    "poe/openai/sora-2",
    "poe/openai/sora-2-pro",
    "poe/poetools/claude-code",
    "poe/runwayml/runway",
    "poe/runwayml/runway-gen-4-turbo",
    "poe/stabilityai/stablediffusionxl",
    "poe/topazlabs-co/topazlabs",
    "poe/trytako/tako",
    "poe/xai/grok-4.1-fast-non-reasoning",
    "poe/xai/grok-4.1-fast-reasoning",
    "qiniu-ai/MiniMax-M1",
    "qiniu-ai/claude-3.5-haiku",
    "qiniu-ai/claude-3.5-sonnet",
    "qiniu-ai/claude-3.7-sonnet",
    "qiniu-ai/claude-4.0-opus",
    "qiniu-ai/claude-4.0-sonnet",
    "qiniu-ai/claude-4.1-opus",
    "qiniu-ai/claude-4.5-haiku",
    "qiniu-ai/claude-4.5-opus",
    "qiniu-ai/claude-4.5-sonnet",
    "qiniu-ai/deepseek-r1",
    "qiniu-ai/deepseek-r1-0528",
    "qiniu-ai/deepseek-v3",
    "qiniu-ai/deepseek-v3-0324",
    "qiniu-ai/deepseek-v3.1",
    "qiniu-ai/deepseek/deepseek-math-v2",
    "qiniu-ai/deepseek/deepseek-v3.1-terminus",
    "qiniu-ai/deepseek/deepseek-v3.1-terminus-thinking",
    "qiniu-ai/deepseek/deepseek-v3.2-251201",
    "qiniu-ai/deepseek/deepseek-v3.2-exp",
    "qiniu-ai/deepseek/deepseek-v3.2-exp-thinking",
    "qiniu-ai/doubao-1.5-pro-32k",
    "qiniu-ai/doubao-1.5-thinking-pro",
    "qiniu-ai/doubao-1.5-vision-pro",
    "qiniu-ai/doubao-seed-1.6",
    "qiniu-ai/doubao-seed-1.6-flash",
    "qiniu-ai/doubao-seed-1.6-thinking",
    "qiniu-ai/doubao-seed-2.0-code",
    "qiniu-ai/doubao-seed-2.0-lite",
    "qiniu-ai/doubao-seed-2.0-mini",
    "qiniu-ai/doubao-seed-2.0-pro",
    "qiniu-ai/gemini-2.0-flash",
    "qiniu-ai/gemini-2.0-flash-lite",
    "qiniu-ai/gemini-2.5-flash",
    "qiniu-ai/gemini-2.5-flash-image",
    "qiniu-ai/gemini-2.5-flash-lite",
    "qiniu-ai/gemini-2.5-pro",
    "qiniu-ai/gemini-3.0-flash-preview",
    "qiniu-ai/gemini-3.0-pro-image-preview",
    "qiniu-ai/gemini-3.0-pro-preview",
    "qiniu-ai/glm-4.5",
    "qiniu-ai/glm-4.5-air",
    "qiniu-ai/gpt-oss-120b",
    "qiniu-ai/gpt-oss-20b",
    "qiniu-ai/kimi-k2",
    "qiniu-ai/kling-v2-6",
    "qiniu-ai/meituan/longcat-flash-chat",
    "qiniu-ai/meituan/longcat-flash-lite",
    "qiniu-ai/minimax/minimax-m2",
    "qiniu-ai/minimax/minimax-m2.1",
    "qiniu-ai/minimax/minimax-m2.5",
    "qiniu-ai/minimax/minimax-m2.5-highspeed",
    "qiniu-ai/moonshotai/kimi-k2-thinking",
    "qiniu-ai/moonshotai/kimi-k2-0905",
    "qiniu-ai/moonshotai/kimi-k2.5",
    "qiniu-ai/openai/gpt-5",
    "qiniu-ai/openai/gpt-5.2",
    "qiniu-ai/qwen-max-2025-01-25",
    "qiniu-ai/qwen-turbo",
    "qiniu-ai/qwen-vl-max-2025-01-25",
    "qiniu-ai/qwen2.5-vl-72b-instruct",
    "qiniu-ai/qwen2.5-vl-7b-instruct",
    "qiniu-ai/qwen3-coder-480b-a35b-instruct",
    "qiniu-ai/qwen3-max",
    "qiniu-ai/qwen3-max-preview",
    "qiniu-ai/qwen3-next-80b-a3b-instruct",
    "qiniu-ai/qwen3-next-80b-a3b-thinking",
    "qiniu-ai/qwen3-vl-30b-a3b-thinking",
    "qiniu-ai/qwen3-235b-a22b",
    "qiniu-ai/qwen3-235b-a22b-instruct-2507",
    "qiniu-ai/qwen3-235b-a22b-thinking-2507",
    "qiniu-ai/qwen3-30b-a3b",
    "qiniu-ai/qwen3-30b-a3b-instruct-2507",
    "qiniu-ai/qwen3-30b-a3b-thinking-2507",
    "qiniu-ai/qwen3-32b",
    "qiniu-ai/qwen3.5-397b-a17b",
    "qiniu-ai/stepfun-ai/gelab-zero-4b-preview",
    "qiniu-ai/stepfun/step-3.5-flash",
    "qiniu-ai/x-ai/grok-4-fast",
    "qiniu-ai/x-ai/grok-4-fast-non-reasoning",
    "qiniu-ai/x-ai/grok-4-fast-reasoning",
    "qiniu-ai/x-ai/grok-4.1-fast",
    "qiniu-ai/x-ai/grok-4.1-fast-non-reasoning",
    "qiniu-ai/x-ai/grok-4.1-fast-reasoning",
    "qiniu-ai/x-ai/grok-code-fast-1",
    "qiniu-ai/z-ai/autoglm-phone-9b",
    "qiniu-ai/z-ai/glm-4.6",
    "qiniu-ai/z-ai/glm-4.7",
    "qiniu-ai/z-ai/glm-5",
    "sakana/fugu",
    "sarvam/sarvam-105b",
    "sarvam/sarvam-30b",
    "snowflake-cortex/claude-fable-5",
    "snowflake-cortex/claude-haiku-4-5",
    "snowflake-cortex/claude-opus-4-7",
    "snowflake-cortex/claude-opus-4-8",
    "snowflake-cortex/claude-sonnet-4-5",
    "snowflake-cortex/claude-sonnet-4-6",
    "snowflake-cortex/deepseek-r1",
    "snowflake-cortex/gemini-3.1-pro",
    "snowflake-cortex/mistral-large2",
    "snowflake-cortex/openai-gpt-4.1",
    "snowflake-cortex/openai-gpt-5",
    "snowflake-cortex/openai-gpt-5-mini",
    "snowflake-cortex/openai-gpt-5-nano",
    "snowflake-cortex/openai-gpt-5.1",
    "snowflake-cortex/openai-gpt-5.2",
    "snowflake-cortex/openai-gpt-5.4",
    "snowflake-cortex/openai-gpt-5.5",
    "snowflake-cortex/openai-gpt-5.6-luna",
    "snowflake-cortex/openai-gpt-5.6-sol",
    "snowflake-cortex/openai-gpt-5.6-terra",
    "snowflake-cortex/snowflake-llama3.3-70b",
    "stepfun-ai-step-plan/step-3.5-flash",
    "stepfun-ai-step-plan/step-3.5-flash-2603",
    "stepfun-ai-step-plan/step-3.7-flash",
    "stepfun-ai/step-tts-2",
    "stepfun-ai/stepaudio-2.5-asr",
    "stepfun-ai/stepaudio-2.5-tts",
    "stepfun-step-plan/step-3.5-flash",
    "stepfun-step-plan/step-3.5-flash-2603",
    "stepfun-step-plan/step-3.7-flash",
    "stepfun-step-plan/step-router-v1",
    "stepfun/step-tts-2",
    "stepfun/stepaudio-2.5-asr",
    "stepfun/stepaudio-2.5-tts",
    "the-grid-ai/agent-max",
    "the-grid-ai/agent-prime",
    "the-grid-ai/agent-standard",
    "the-grid-ai/code-max",
    "the-grid-ai/code-prime",
    "the-grid-ai/code-standard",
    "the-grid-ai/text-max",
    "the-grid-ai/text-prime",
    "the-grid-ai/text-standard",
    "trustedrouter/auto",
    "trustedrouter/cheap",
    "trustedrouter/e2e",
    "trustedrouter/fast",
    "trustedrouter/synth",
    "trustedrouter/synth-code",
    "trustedrouter/zdr",
    "vercel/alibaba/qwen3-embedding-0.6b",
    "vercel/alibaba/qwen3-embedding-4b",
    "vercel/alibaba/qwen3-embedding-8b",
    "vercel/alibaba/wan-v2.5-t2v-preview",
    "vercel/alibaba/wan-v2.6-i2v",
    "vercel/alibaba/wan-v2.6-i2v-flash",
    "vercel/alibaba/wan-v2.6-r2v",
    "vercel/alibaba/wan-v2.6-r2v-flash",
    "vercel/alibaba/wan-v2.6-t2v",
    "vercel/alibaba/wan-v2.7-r2v",
    "vercel/alibaba/wan-v2.7-t2v",
    "vercel/amazon/titan-embed-text-v2",
    "vercel/bfl/flux-2-flex",
    "vercel/bfl/flux-2-klein-4b",
    "vercel/bfl/flux-2-klein-9b",
    "vercel/bfl/flux-2-max",
    "vercel/bfl/flux-2-pro",
    "vercel/bfl/flux-kontext-max",
    "vercel/bfl/flux-kontext-pro",
    "vercel/bfl/flux-pro-1.0-fill",
    "vercel/bfl/flux-pro-1.1",
    "vercel/bfl/flux-pro-1.1-ultra",
    "vercel/bytedance/seedance-2.0",
    "vercel/bytedance/seedance-2.0-fast",
    "vercel/bytedance/seedance-v1.0-pro",
    "vercel/bytedance/seedance-v1.0-pro-fast",
    "vercel/bytedance/seedance-v1.5-pro",
    "vercel/bytedance/seedream-4.0",
    "vercel/bytedance/seedream-4.5",
    "vercel/bytedance/seedream-5.0-lite",
    "vercel/bytedance/seedream-5.0-pro",
    "vercel/cohere/embed-v4.0",
    "vercel/cohere/rerank-v3.5",
    "vercel/cohere/rerank-v4-fast",
    "vercel/cohere/rerank-v4-pro",
    "vercel/google/gemini-embedding-001",
    "vercel/google/gemini-embedding-2",
    "vercel/google/imagen-4.0-fast-generate-001",
    "vercel/google/imagen-4.0-generate-001",
    "vercel/google/imagen-4.0-ultra-generate-001",
    "vercel/google/text-embedding-005",
    "vercel/google/text-multilingual-embedding-002",
    "vercel/google/veo-3.0-fast-generate-001",
    "vercel/google/veo-3.0-generate-001",
    "vercel/google/veo-3.1-fast-generate-001",
    "vercel/google/veo-3.1-generate-001",
    "vercel/klingai/kling-v2.5-turbo-i2v",
    "vercel/klingai/kling-v2.5-turbo-t2v",
    "vercel/klingai/kling-v2.6-i2v",
    "vercel/klingai/kling-v2.6-motion-control",
    "vercel/klingai/kling-v2.6-t2v",
    "vercel/klingai/kling-v3.0-i2v",
    "vercel/klingai/kling-v3.0-motion-control",
    "vercel/klingai/kling-v3.0-t2v",
    "vercel/mistral/codestral-embed",
    "vercel/mistral/mistral-embed",
    "vercel/openai/gpt-realtime-whisper",
    "vercel/openai/text-embedding-3-large",
    "vercel/openai/text-embedding-3-small",
    "vercel/openai/text-embedding-ada-002",
    "vercel/openai/tts-1",
    "vercel/openai/tts-1-hd",
    "vercel/openai/whisper-1",
    "vercel/perplexity/sonar",
    "vercel/perplexity/sonar-pro",
    "vercel/perplexity/sonar-reasoning-pro",
    "vercel/prodia/flux-fast-schnell",
    "vercel/quiverai/arrow-1.1",
    "vercel/recraft/recraft-v2",
    "vercel/recraft/recraft-v3",
    "vercel/recraft/recraft-v4",
    "vercel/recraft/recraft-v4-pro",
    "vercel/recraft/recraft-v4.1",
    "vercel/recraft/recraft-v4.1-pro",
    "vercel/recraft/recraft-v4.1-utility",
    "vercel/recraft/recraft-v4.1-utility-pro",
    "vercel/voyage/rerank-2.5",
    "vercel/voyage/rerank-2.5-lite",
    "vercel/voyage/voyage-3-large",
    "vercel/voyage/voyage-3.5",
    "vercel/voyage/voyage-3.5-lite",
    "vercel/voyage/voyage-4",
    "vercel/voyage/voyage-4-large",
    "vercel/voyage/voyage-4-lite",
    "vercel/voyage/voyage-code-2",
    "vercel/voyage/voyage-code-3",
    "vercel/voyage/voyage-finance-2",
    "vercel/voyage/voyage-law-2",
    "vercel/xai/grok-imagine-image",
    "vercel/xai/grok-imagine-video",
    "vercel/xai/grok-imagine-video-1.5",
    "vercel/xai/grok-imagine-video-1.5-preview",
    "vercel/xai/grok-stt",
    "vercel/xai/grok-tts",
    "vercel/xai/grok-voice-think-fast-1.0",
    "vercel/zai/glm-4.6v-flash",
    "xai/grok-imagine-image",
    "xai/grok-imagine-image-quality",
    "xai/grok-imagine-video",
    "xai/grok-imagine-video-1.5",
  ];

  test("cost-less model set equals the pinned baseline", () => {
    const missing: string[] = [];
    for (const p of getProviders()) {
      for (const m of getModelsForProvider(p.id)) {
        const hasCost =
          m.cost &&
          typeof m.cost.input === "number" &&
          typeof m.cost.output === "number";
        if (!hasCost) missing.push(`${p.id}/${m.id}`);
      }
    }
    missing.sort();
    const sorted = [...KNOWN_MISSING_COST].sort();
    if (missing.length !== sorted.length) {
      const added = missing.filter((x) => !sorted.includes(x));
      const removed = sorted.filter((x) => !missing.includes(x));
      console.warn(
        `[catalog] cost-less models diverged from baseline. added=${added.length} removed=${removed.length}`,
      );
      if (added.length) console.warn("  added: " + added.join(", "));
      if (removed.length) console.warn("  removed: " + removed.join(", "));
    }
    expect(missing).toEqual(sorted);
  });
});

describe("getDefaultModelForProvider", () => {
  const PROVIDERS = ["openai", "anthropic", "google", "deepseek", "xai", "openrouter"];

  for (const id of PROVIDERS) {
    test(`${id} returns a real, non-deprecated model id`, () => {
      const def = getDefaultModelForProvider(id);
      expect(def, `${id} default should be non-empty`).not.toBe("");
      expect(typeof def).toBe("string");
      const models = getModelsForProvider(id);
      const found = models.find((m) => m.id === def);
      expect(found, `${id} default ${def} not present in getModelsForProvider`).toBeDefined();
      expect(found!.status).not.toBe("deprecated");
    });
  }
});

describe("getDefaultModelForProvider — family priority", () => {
  test("a priority list wins over a newer release", () => {
    // gpt-5.6 (2026-07-09) is newer than gpt-5.4 (2026-03-05), yet the
    // priority list must select gpt-5.4.
    expect(getDefaultModelForProvider("openai", ["gpt-5.4", "gpt-5.2"])).toBe("gpt-5.4");
  });

  test("priority entries are matched prefix-tolerantly (catalogIdMatches)", () => {
    expect(getDefaultModelForProvider("openai", ["openai/gpt-5.4"])).toBe("gpt-5.4");
  });

  test("an unknown priority family falls back to newest-stable", () => {
    const stable = getModelsForProvider("openai")
      .filter((m) => m.status !== "alpha" && m.status !== "beta" && m.status !== "deprecated")
      .sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")));
    expect(getDefaultModelForProvider("openai", ["gpt-9.9"])).toBe(stable[0].id);
  });

  test("missing priority entries are skipped in favor of a later one", () => {
    expect(getDefaultModelForProvider("openai", ["gpt-9.9", "gpt-5.2"])).toBe("gpt-5.2");
  });

  test("without a priority argument the newest-stable behavior is unchanged", () => {
    expect(getDefaultModelForProvider("openai")).toBe("gpt-5.6");
  });
});

describe("experimental (alpha/beta) models are never chosen by default resolution", () => {
  test("openai default is stable", () => {
    const def = getDefaultModelForProvider("openai");
    const model = getModelsForProvider("openai").find((m) => m.id === def);
    expect(model?.status).not.toBe("alpha");
    expect(model?.status).not.toBe("beta");
  });

  test("azure default is stable even though azure carries beta models", () => {
    const def = getDefaultModelForProvider("azure");
    const model = getModelsForProvider("azure").find((m) => m.id === def);
    expect(model).toBeDefined();
    expect(model?.status).not.toBe("alpha");
    expect(model?.status).not.toBe("beta");
  });

  test("priority resolution skips an experimental priority entry", () => {
    // gpt-5.6-luna is beta in the azure catalog — the priority walk must skip
    // it and fall through to the newest stable azure model.
    const def = getDefaultModelForProvider("azure", ["gpt-5.6-luna"]);
    const model = getModelsForProvider("azure").find((m) => m.id === def);
    expect(model).toBeDefined();
    expect(model?.status).not.toBe("alpha");
    expect(model?.status).not.toBe("beta");
  });

  test("a provider whose non-deprecated models are all experimental yields no default", () => {
    // blueclaw/hetzner currently ship only beta Qwen3.6 models — the default
    // must be "" (never an experimental model), so selection stays explicit.
    // If models.dev later adds a stable model for either, this pin needs
    // updating (same discipline as the cost-less baseline above).
    expect(getDefaultModelForProvider("blueclaw")).toBe("");
    expect(getDefaultModelForProvider("hetzner")).toBe("");
  });
});

describe("reasoningOptionsFor — reasoning_options variant surface", () => {
  test("openai gpt-5.4 yields its effort variant list", () => {
    expect(reasoningOptionsFor("gpt-5.4", "openai")).toEqual([
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
    ]);
  });

  test("a model with toggle + effort + budget_tokens yields all three variants", () => {
    expect(reasoningOptionsFor("claude-opus-4-5", "302ai")).toEqual([
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high"] },
      { type: "budget_tokens", min: 1024, max: 63999 },
    ]);
  });

  test("anthropic claude-sonnet-5 yields toggle + a max-effort variant list", () => {
    expect(reasoningOptionsFor("claude-sonnet-5", "anthropic")).toEqual([
      { type: "toggle" },
      { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
    ]);
  });

  test("a model without reasoning_options yields []", () => {
    expect(reasoningOptionsFor("gpt-4o", "openai")).toEqual([]);
  });

  test("an unknown provider or model yields []", () => {
    expect(reasoningOptionsFor("gpt-5.4", "no-such-provider")).toEqual([]);
    expect(reasoningOptionsFor("no-such-model", "openai")).toEqual([]);
  });
});

describe("isValidCatalog", () => {
  test("rejects non-object / string / null", () => {
    expect(isValidCatalog(null)).toBe(false);
    expect(isValidCatalog("not an object")).toBe(false);
    expect(isValidCatalog(42)).toBe(false);
  });

  test("rejects a provider missing models", () => {
    expect(isValidCatalog({ x: { id: "x", name: "X" } })).toBe(false);
  });

  test("rejects a provider missing name", () => {
    expect(isValidCatalog({ x: { id: "x", models: {} } })).toBe(false);
  });

  test("rejects a model with negative cost", () => {
    expect(
      isValidCatalog({
        x: {
          id: "x",
          name: "X",
          models: { a: { id: "a", name: "A", release_date: "2024", cost: { input: -1, output: 1 } } },
        },
      }),
    ).toBe(false);
  });

  test("accepts a tiny valid catalog", () => {
    expect(isValidCatalog({ x: { id: "x", name: "X", models: {} } })).toBe(true);
  });
});

describe("testProviderConnection shape (mocked fetch)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
  });

  function jsonResponse(status: number, body: unknown) {
    const payload = JSON.stringify(body);
    const encoder = new TextEncoder();
    let pushed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed) {
          controller.close();
          return;
        }
        pushed = true;
        controller.enqueue(encoder.encode(payload));
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      body: stream,
      json: async () => body,
      text: async () => payload,
    };
  }

  test("openai: 200 Bearer-keyed models list => ok with modelCount", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "gpt-5.5" }] }));
    const res = await testProviderConnection({ provider: "openai", apiKey: "sk-test-123" });
    expect(res.ok).toBe(true);
    expect(res.modelCount).toBe(1);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.message).toBe("string");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string>; body?: unknown; method?: string }];
    expect(url).toContain("/models");
    expect(init.headers?.Authorization).toMatch(/^Bearer\s+/);
    // Must be a models-list GET, NOT a chat completion call.
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  test("openai: 401 => ok false", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "invalid key" }));
    const res = await testProviderConnection({ provider: "openai", apiKey: "sk-bad" });
    expect(res.ok).toBe(false);
    expect(typeof res.message).toBe("string");
  });

  test("openai: no request body ever contains a chat messages array", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "gpt-5.5" }] }));
    await testProviderConnection({ provider: "openai", apiKey: "sk-test-123" });
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { body?: unknown };
      const serialized = init?.body ? JSON.stringify(init.body) : "";
      expect(serialized).not.toContain("messages");
    }
  });

  test("azure: builds /openai/deployments URL and uses api-key header (not Bearer)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "gpt-4" }] }));
    const res = await testProviderConnection({
      provider: "azure",
      apiKey: "azure-key",
      resourceName: "my-resource",
    });
    expect(res.ok).toBe(true);
    expect(res.modelCount).toBe(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
    expect(url).toContain("/openai/deployments");
    expect(url).toContain("api-version=");
    expect(init.headers?.["api-key"]).toBe("azure-key");
    expect(init.headers?.Authorization).toBeUndefined();
  });
});

describe("catalogIdMatches", () => {
  test("exact match", () => {
    expect(catalogIdMatches("gpt-4o", "gpt-4o")).toBe(true);
  });

  test("provider prefix stripped from both sides", () => {
    expect(catalogIdMatches("openai/gpt-4o", "gpt-4o")).toBe(true);
    expect(catalogIdMatches("gpt-4o", "openai/gpt-4o")).toBe(true);
  });

  test("same model with different provider prefix", () => {
    expect(catalogIdMatches("openai/gpt-4o", "openai/gpt-4o")).toBe(true);
  });

  test("case-insensitive", () => {
    expect(catalogIdMatches("OpenAI/GPT-4o", "openai/gpt-4o")).toBe(true);
  });

  test("no false positive: gpt-4o does not match gpt-4o-mini", () => {
    expect(catalogIdMatches("gpt-4o", "gpt-4o-mini")).toBe(false);
    expect(catalogIdMatches("gpt-4o-mini", "gpt-4o")).toBe(false);
  });

  test("date-stamped and undated spellings of the same model canonicalize to one record", () => {
    expect(catalogIdMatches("gpt-4o", "gpt-4o-2024-08-06")).toBe(true);
    expect(catalogIdMatches("gpt-4o-2024-08-06", "gpt-4o")).toBe(true);
    expect(catalogIdMatches("openai/gpt-4o-2024-11-20", "openai/gpt-4o")).toBe(true);
    // …but a DIFFERENT model that merely shares a prefix still never matches.
    expect(catalogIdMatches("gpt-4o", "gpt-4o-mini-2024-08-06")).toBe(false);
  });

  test("OpenRouter :variant suffixes are stripped on both sides", () => {
    expect(catalogIdMatches("openai/gpt-oss-20b:free", "openai/gpt-oss-20b")).toBe(true);
    expect(catalogIdMatches("nvidia/nemotron-3-nano-30b-a3b:free", "nvidia/nemotron-3-nano-30b-a3b")).toBe(true);
    expect(catalogIdMatches("openai/gpt-5:thinking", "gpt-5")).toBe(true);
    expect(catalogIdMatches("deepseek/deepseek-r1:free", "deepseek/deepseek-r1")).toBe(true);
  });

  test("no false positive: partial substring does not match", () => {
    expect(catalogIdMatches("claude", "claude-opus-4")).toBe(false);
    expect(catalogIdMatches("gpt", "gpt-4o")).toBe(false);
  });

  test("provider/ prefix with suffix model matches exactly", () => {
    expect(catalogIdMatches("openai/gpt-4o", "openai/gpt-4o")).toBe(true);
    expect(catalogIdMatches("anthropic/claude-opus-4", "claude-opus-4")).toBe(true);
  });

  test("no false positive: openai/gpt-4 does not match provider/openai/gpt-4o", () => {
    expect(catalogIdMatches("openai/gpt-4", "provider/openai/gpt-4o")).toBe(false);
  });
});

describe("fetchCatalog — stale-while-refresh", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /** A minimal valid models.dev-shaped catalog served by the fetch stub. */
  function miniCatalog(): Catalog {
    return {
      tp: {
        id: "tp",
        name: "Test Provider",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: { input: 1, output: 2 },
          },
        },
      },
    };
  }

  beforeEach(() => {
    __resetCatalogForTests();
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => miniCatalog() }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("a successful live load arms a one-shot refresh (stale-while-refresh)", async () => {
    vi.useFakeTimers();
    await fetchCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // CACHE_TTL_MS after the successful load the one-shot timer re-fetches.
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("the refresh chain re-arms after each successful load", async () => {
    vi.useFakeTimers();
    await fetchCatalog({ force: true });
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("a failed live load does not arm a refresh", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("network down"));
    await fetchCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("force bypasses the memory TTL", async () => {
    await fetchCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Memory TTL is still fresh — a non-force call must NOT re-fetch.
    await fetchCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // force bypasses the memory TTL and goes to the network again.
    await fetchCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a scheduled refresh does not double-fetch while a force load is in flight", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: { ok: boolean; status: number; json: () => Promise<Catalog> }) => void;
    fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Boot-style arm — background/index.ts calls this after the first
    // successful worker load.
    scheduleRefresh();
    const inflight = fetchCatalog({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The timer fires while the force fetch is in flight — the inflight memo
    // dedupes it, so exactly one fetch happens.
    await vi.advanceTimersByTimeAsync(CACHE_TTL_MS);
    resolveFetch({ ok: true, status: 200, json: async () => miniCatalog() });
    await inflight;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
