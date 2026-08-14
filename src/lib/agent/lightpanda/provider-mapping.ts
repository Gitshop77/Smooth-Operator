/**
 * Map the harness's ProviderConfig to a `lightpanda agent` launch.
 *
 * The research action runs Lightpanda's own agent loop with the SAME AI as the
 * main agent: same provider, model, base URL and API key. Lightpanda accepts
 * --provider / --model / --base-url plus API keys via environment variables;
 * the keys in `env` are the only values ever passed to the child process.
 *
 * Validated against lightpanda 1.0.0-dev (Config.zig:252, zenai provider.zig):
 *   --provider accepts: anthropic, gemini, vertex, openai, ollama,
 *     huggingface, llama_cpp, openai_compatible, vercel, mistral, codex.
 *   openai_compatible REQUIRES a base URL — provided BOTH as --base-url AND
 *     OPENAI_BASE_URL env (the credential-resolution gate at
 *     provider.zig:1261-1264 reads the env var; missing -> exit 1).
 *   Env keys: ANTHROPIC_API_KEY (anthropic), OPENAI_API_KEY (openai /
 *     openai_compatible), GOOGLE_API_KEY | GEMINI_API_KEY (gemini),
 *     HF_TOKEN (huggingface), AI_GATEWAY_API_KEY (vercel),
 *     MISTRAL_API_KEY (mistral). ollama needs NO key (placeholder "ollama",
 *     default base http://localhost:11434/v1).
 *
 * Harness-specific mapping notes:
 *   - The harness's 15-entry profile table (openai-compatible-profile.ts:40-62)
 *     gets explicit entries here with the SAME default base URLs, so users who
 *     never typed a baseUrl still work (deepseek, groq, qwen, together,
 *     cerebras, baseten, deepinfra, fireworks, opencode, opencode-go, litellm).
 *   - azure: the harness stores `resourceName`; synthesize the OpenAI-
 *     compatible endpoint https://{resource}.openai.azure.com/openai/v1.
 *   - google is Vertex AI in the harness: it requires a user-supplied baseUrl
 *     and has NO static default (provider-config.ts), so it falls through to
 *     the generic openai_compatible path — never map it to gemini.
 */

export interface ProviderConfigLike {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Azure resource name — synthesized into the endpoint URL when baseUrl is absent. */
  resourceName?: string;
}

export interface LightpandaLaunch {
  provider: string;
  model?: string;
  baseUrl?: string;
  env: Record<string, string>;
}

export type BuildLightpandaLaunchResult =
  | { ok: true; launch: LightpandaLaunch }
  | { ok: false; error: string };

const OPENAI_COMPATIBLE = "openai_compatible";

interface Mapping {
  /** Lightpanda --provider value. */
  provider: string;
  /** Fixed base URL when Lightpanda's default must not be relied on. */
  baseUrl?: string;
  /** Environment variable that carries the API key. */
  envKey?: string;
  /** Whether an API key is required. ollama and litellm are keyless. */
  needsKey: boolean;
}

/** Dedicated lightpanda providers + the harness's known OpenAI-compatible endpoints. */
const PROVIDER_MAPPINGS: Record<string, Mapping> = {
  openai:    { provider: "openai", envKey: "OPENAI_API_KEY", needsKey: true },
  anthropic: { provider: "anthropic", envKey: "ANTHROPIC_API_KEY", needsKey: true },
  gemini:    { provider: "gemini", envKey: "GEMINI_API_KEY", needsKey: true },
  mistral:   { provider: "mistral", envKey: "MISTRAL_API_KEY", needsKey: true },
  xai:       { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.x.ai/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  openrouter: { provider: OPENAI_COMPATIBLE, baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  azure:     { provider: OPENAI_COMPATIBLE, envKey: "OPENAI_API_KEY", needsKey: true },
  // Local models need no API key; Lightpanda's ollama provider uses a
  // placeholder key and defaults to http://localhost:11434/v1.
  ollama:    { provider: "ollama", baseUrl: "http://localhost:11434/v1", needsKey: false },
  // Profile-table OpenAI-compatible services — base URLs mirror
  // src/lib/agent/llm/providers/openai-compatible-profile.ts:40-62.
  deepseek:  { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.deepseek.com", envKey: "OPENAI_API_KEY", needsKey: true },
  groq:      { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.groq.com/openai/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  qwen:      { provider: OPENAI_COMPATIBLE, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  together:  { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.together.ai/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  cerebras:  { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.cerebras.ai/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  baseten:   { provider: OPENAI_COMPATIBLE, baseUrl: "https://inference.baseten.co/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  deepinfra: { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.deepinfra.com/v1/openai", envKey: "OPENAI_API_KEY", needsKey: true },
  fireworks: { provider: OPENAI_COMPATIBLE, baseUrl: "https://api.fireworks.ai/inference/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  opencode:  { provider: OPENAI_COMPATIBLE, baseUrl: "https://opencode.ai/zen/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  "opencode-go": { provider: OPENAI_COMPATIBLE, baseUrl: "https://opencode.ai/zen/go/v1", envKey: "OPENAI_API_KEY", needsKey: true },
  // Local proxy — keyless, like ollama.
  litellm:   { provider: OPENAI_COMPATIBLE, baseUrl: "http://localhost:4000/v1", needsKey: false },
};

export function buildLightpandaLaunch(cfg: ProviderConfigLike): BuildLightpandaLaunchResult {
  if (!cfg || typeof cfg.provider !== "string" || cfg.provider === "") {
    return { ok: false, error: "no LLM provider configured — configure the main AI in the extension options first" };
  }
  const mapping = PROVIDER_MAPPINGS[cfg.provider];
  if (!mapping) {
    // Generic fallback: any other provider works only as an OpenAI-compatible
    // endpoint with a user-supplied base URL (covers `google`/Vertex, which
    // has no static default, and future catalog-only ids). Fail closed.
    if (!cfg.baseUrl) {
      return { ok: false, error: `provider "${cfg.provider}" is not supported for Lightpanda research (no known endpoint)` };
    }
    if (!cfg.apiKey) {
      return { ok: false, error: "no API key available — research needs the same AI as the main agent" };
    }
    return {
      ok: true,
      launch: {
        provider: OPENAI_COMPATIBLE,
        baseUrl: cfg.baseUrl,
        ...(cfg.model ? { model: cfg.model } : {}),
        env: { OPENAI_API_KEY: cfg.apiKey, OPENAI_BASE_URL: cfg.baseUrl },
      },
    };
  }
  if (mapping.needsKey && !cfg.apiKey) {
    return { ok: false, error: "no API key available — research needs the same AI as the main agent" };
  }
  // azure: synthesize https://{resource}.openai.azure.com/openai/v1 from the
  // harness's resourceName when the user never set a baseUrl.
  const synthesized =
    cfg.provider === "azure" && cfg.resourceName
      ? `https://${cfg.resourceName}.openai.azure.com/openai/v1`
      : undefined;
  const baseUrl = cfg.baseUrl ?? mapping.baseUrl ?? synthesized;
  if (mapping.provider === OPENAI_COMPATIBLE && !baseUrl) {
    return { ok: false, error: `provider "${cfg.provider}" needs a base URL for Lightpanda research` };
  }
  const env: Record<string, string> = {};
  if (mapping.envKey && cfg.apiKey) env[mapping.envKey] = cfg.apiKey;
  if (mapping.provider === OPENAI_COMPATIBLE && baseUrl) env.OPENAI_BASE_URL = baseUrl;
  return {
    ok: true,
    launch: {
      provider: mapping.provider,
      ...(baseUrl ? { baseUrl } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      env,
    },
  };
}