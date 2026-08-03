/**
 * LLM protocol tests — request-body construction + stream-frame parsing for
 * each wire protocol.
 *
 * Also provides the regression fixture for streaming truncation
 * (`finish_reason` check).
 */

import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import * as OpenAIChat from "../src/lib/agent/llm/protocols/openai-chat";
import * as OpenAICompatibleChat from "../src/lib/agent/llm/protocols/openai-compatible-chat";
import * as AnthropicMessages from "../src/lib/agent/llm/protocols/anthropic-messages";
import * as Gemini from "../src/lib/agent/llm/protocols/gemini";
import { encodeModelIdForUrl } from "../src/lib/agent/llm/modelId";
import { hasImageProvenance, isPlainJSONSchema } from "../src/lib/agent/llm/shared-image";
import { isValidCatalog, resolveVisionSupport, type CatalogModel } from "../src/lib/agent/llm/catalog";
import { CACHE_KEY } from "../src/lib/agent/llm/catalog-data";
import { configure as configureAzure } from "../src/lib/agent/llm/providers/azure";
import { generate } from "../src/lib/agent/llm/route/client";
import type { LLMRequest } from "../src/lib/agent/llm/route/client";
import { normalizeStrictSchema } from "../src/lib/agent/llm/protocols/openai-chat-utils";

/** Minimal structural shape of a protocol's stream reducer, used by `reduceFrames`. */
type StreamProtocol = {
  stream: {
    initial(request: LLMRequest): unknown;
    step(state: unknown, frame: string): { state: unknown; events: unknown[] };
    terminal?(frame: string): boolean;
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal LLMRequest the protocol's `body.from()` can consume. */
function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: { id: "test-model", provider: "test", routeId: "test" },
    messages: [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "Say hello." },
    ],
    generation: { temperature: 0, maxTokens: 100 },
    ...overrides,
  } as LLMRequest;
}

/** Drive a list of raw frame strings through a protocol's stream reducer. */
function reduceFrames(
  protocol: StreamProtocol,
  frames: string[],
  request: LLMRequest
): { content: string; events: unknown[]; terminatedEarly: boolean } {
  let state = protocol.stream.initial(request);
  let content = "";
  const events: unknown[] = [];
  let terminatedEarly = false;
  for (const frame of frames) {
    if (protocol.stream.terminal?.(frame)) {
      const { state: ns, events: ev } = protocol.stream.step(state, frame);
      state = ns;
      for (const e of ev) {
        events.push(e);
        if ((e as { type?: string; content?: string }).type === "text" && (e as { content?: string }).content) {
          content += (e as { content?: string }).content;
        }
      }
      terminatedEarly = true;
      break;
    }
    const { state: ns, events: ev } = protocol.stream.step(state, frame);
    state = ns;
    for (const e of ev) {
      events.push(e);
      if ((e as { type?: string; content?: string }).type === "text" && (e as { content?: string }).content) {
        content += (e as { content?: string }).content;
      }
    }
  }
  return { content, events, terminatedEarly };
}

// ─── OpenAI Chat protocol ───────────────────────────────────────────────────

describe("OpenAIChat.protocol — body construction", () => {
  test("builds a valid chat-completions body", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest()) as OpenAIChat.OpenAIChatBody;
    expect(body.model).toBe("test-model");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a test assistant." });
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(100);
  });

  test("serializes the schema into response_format.json_schema for structured output", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({ schema: { type: "object" } } as Partial<LLMRequest>)) as OpenAIChat.OpenAIChatBody;
    expect(body.response_format).toBeDefined();
    expect(body.response_format!.type).toBe("json_schema");
    const js = (body.response_format as { json_schema: { name: string; schema: Record<string, unknown>; strict: boolean } }).json_schema;
    // The `name` is a fixed alphanumeric identifier required by the OpenAI
    // structured-output API.
    expect(js.name).toBe("response");
    expect(js.strict).toBe(true);
    // The schema is serialized into `json_schema.schema` (not discarded, as
    // the old `json_object` form did).
    expect(js.schema).toBeDefined();
    expect(js.schema).toEqual({ type: "object" });
  });

  test("omits response_format when no schema", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest()) as OpenAIChat.OpenAIChatBody;
    expect(body.response_format).toBeUndefined();
  });

  test("extracts <screenshot> marker into an image_url content part (not raw base64 text)", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: 'See this: <screenshot>data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==</screenshot>' },
      ],
    })) as OpenAIChat.OpenAIChatBody;
    const userMsg = body.messages[1];
    // The content must be an array of parts, NOT a plain string.
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as OpenAIChat.OpenAIContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "See this:" });
    expect(parts[1].type).toBe("image_url");
    expect((parts[1] as { image_url: { url: string } }).image_url.url).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==");
    // The raw base64 must NOT appear as prompt text anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("image_url");
    // The data URL appears exactly once — inside the image_url part, not as text.
    expect((serialized.match(/data:image\/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==/g) || []).length).toBe(1);
  });

  test("rejects a <screenshot> marker whose payload fails the provenance check", async () => {
    // Declared `png` but the base64 starts with JPEG magic bytes ("/9j/"):
    // `hasImageProvenance` must reject it so injected bytes aren't forwarded.
    const badPayload = "/9j/AAAA";
    await expect(
      OpenAIChat.protocol.body.from(makeRequest({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: `See: <screenshot>data:image/png;base64,${badPayload}</screenshot>` },
        ],
      }))
    ).rejects.toThrow(/provenance check/);
  });

  test("a user message without a screenshot stays a plain string", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Just text, no image." },
      ],
    })) as OpenAIChat.OpenAIChatBody;
    expect(typeof body.messages[1].content).toBe("string");
    expect(body.messages[1].content).toBe("Just text, no image.");
  });

  test("max_tokens defaults to 4096 when the caller doesn't set one", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({ generation: { temperature: 0 } } as Partial<LLMRequest>)) as OpenAIChat.OpenAIChatBody;
    expect(body.max_tokens).toBe(4096);
  });

  test("emits reasoning_effort in the reasoning branch when effort is configured", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({
      reasoning: true,
      reasoningConfig: { effort: "high" },
    })) as OpenAIChat.OpenAIChatBody;
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_completion_tokens).toBe(100);
    expect(body.temperature).toBeUndefined();
  });

  test("omits reasoning_effort when no effort is configured", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({ reasoning: true })) as OpenAIChat.OpenAIChatBody;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBe(100);
  });

  test("suppresses the whole reasoning branch when enabled === false", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({
      reasoning: true,
      reasoningConfig: { enabled: false },
    })) as OpenAIChat.OpenAIChatBody;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(100);
  });
});

describe("OpenAIChat.protocol — streaming truncation regression", () => {
  // Realistic OpenAI SSE chunk sequence: every delta includes
  // `finish_reason: null`; only the final delta sets it to `"stop"`.
  // OpenAI sends `usage` in a SEPARATE chunk AFTER `finish_reason` (with
  // empty `choices: []`), followed by the `[DONE]` sentinel. A naive
  // `terminal` would return `true` on a non-null `finish_reason`, exiting
  // the stream loop BEFORE the usage chunk arrived — silently dropping
  // cost/token accounting on every OpenAI-format provider.
  const realisticChunks = [
    JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: ", " }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: { content: "world!" }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    "[DONE]",
  ];

  test("does NOT terminate on intermediate chunks with finish_reason: null", async () => {
    // The first chunk has finish_reason: null — a naive terminal() would
    // return true for it. The terminal() guard must return false here.
    expect(OpenAIChat.protocol.stream.terminal?.(realisticChunks[0])).toBe(false);
  });

  test("does NOT terminate on a chunk with non-null finish_reason (waits for usage + [DONE])", async () => {
    // The chunk with finish_reason: "stop" must NOT terminate the loop —
    // OpenAI sends `usage` in a separate chunk AFTER it. Terminating here
    // would silently drop cost/token accounting.
    expect(OpenAIChat.protocol.stream.terminal?.(realisticChunks[4])).toBe(false);
  });

  test("does NOT terminate on the usage chunk (empty choices + usage)", async () => {
    // The usage chunk arrives after finish_reason and before [DONE]. It must
    // NOT terminate the loop — `step()` needs to record the usage first, then
    // `[DONE]` triggers the finish event.
    expect(OpenAIChat.protocol.stream.terminal?.(realisticChunks[5])).toBe(false);
  });

  test("terminates on the [DONE] sentinel", async () => {
    expect(OpenAIChat.protocol.stream.terminal?.("[DONE]")).toBe(true);
  });

  test("reduces a full multi-chunk stream without early termination", async () => {
    const { content, terminatedEarly } = reduceFrames(OpenAIChat.protocol, realisticChunks, makeRequest());
    // Without the terminal() guard, content would be "" (terminated on the
    // first chunk before any text delta arrived). With the guard, all three
    // text deltas accumulate.
    expect(content).toBe("Hello, world!");
    expect(terminatedEarly).toBe(true);
  });

  test("captures usage from the post-finish_reason usage chunk", async () => {
    // The full chunk order: deltas -> finish_reason chunk -> usage chunk ->
    // [DONE]. The usage chunk (index 5) must populate `state.usage` so the
    // finish event emitted on `[DONE]` carries the real cost data.
    let state = OpenAIChat.protocol.stream.initial(makeRequest());
    // Step through every chunk except [DONE] so we can inspect the state
    // before the finish event is emitted.
    for (let i = 0; i <= 5; i++) {
      const { state: next } = OpenAIChat.protocol.stream.step(state, realisticChunks[i]);
      state = next as OpenAIChat.StreamState;
    }
    expect((state as OpenAIChat.StreamState).usage).toBeDefined();
    expect((state as OpenAIChat.StreamState).usage?.tokensIn).toBe(10);
    expect((state as OpenAIChat.StreamState).usage?.tokensOut).toBe(5);
  });

  test("the finish event on [DONE] carries usage captured from the usage chunk", async () => {
    const { events } = reduceFrames(OpenAIChat.protocol, realisticChunks, makeRequest());
    const finish = events.find((e) => (e as { type?: string }).type === "finish") as
      | { type: string; usage?: { tokensIn: number; tokensOut: number } }
      | undefined;
    expect(finish).toBeDefined();
    expect(finish?.usage).toBeDefined();
    expect(finish?.usage?.tokensIn).toBe(10);
    expect(finish?.usage?.tokensOut).toBe(5);
  });

  test("reduces a stream that ends with [DONE] but no non-null finish_reason", async () => {
    // Some OpenAI-compatible providers (e.g. older Ollama) emit only [DONE]
    // without a non-null finish_reason. The terminal() guard must still terminate.
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] }),
      "[DONE]",
    ];
    const { content, terminatedEarly } = reduceFrames(OpenAIChat.protocol, chunks, makeRequest());
    expect(content).toBe("Hi");
    expect(terminatedEarly).toBe(true);
  });
});

// ─── OpenAI-compatible Chat protocol ────────────────────────────────────────

describe("OpenAICompatibleChat.protocol", () => {
  test("inherits the fixed terminal() from OpenAIChat (streaming truncation regression)", async () => {
    // openai-compatible-chat reuses OpenAIChat's stream object verbatim, so
    // the fix propagates. Verify explicitly so a future refactor that
    // detaches the two stays correct.
    const intermediateChunk = JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: null }] });
    expect(OpenAICompatibleChat.protocol.stream.terminal?.(intermediateChunk)).toBe(false);
  });

  test("adds frequency_penalty = 0.3 to the body", async () => {
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest()) as OpenAIChat.OpenAIChatBody;
    expect(body.frequency_penalty).toBe(0.3);
  });

  test("skips frequency_penalty for reasoning requests (o-series / grok-reasoning reject it)", async () => {
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest({ reasoning: true })) as OpenAIChat.OpenAIChatBody;
    expect(body.frequency_penalty).toBeUndefined();
  });

  test("drops reasoning_effort for providers that do not opt in (fails closed)", async () => {
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest({
      model: { id: "test-model", provider: "groq", routeId: "test" },
      reasoning: true,
      reasoningConfig: { effort: "high" },
    })) as OpenAIChat.OpenAIChatBody;
    // The openai-chat builder emits reasoning_effort for any reasoning request;
    // the openai-compatible shim must strip it unless the profile opts in.
    expect(body.reasoning_effort).toBeUndefined();
    // The reasoning branch itself is preserved (max_completion_tokens stays).
    expect(body.max_completion_tokens).toBe(100);
  });

  test("forwards reasoning_effort for providers that opt in (openrouter)", async () => {
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest({
      model: { id: "test-model", provider: "openrouter", routeId: "test" },
      reasoning: true,
      reasoningConfig: { effort: "high" },
    })) as OpenAIChat.OpenAIChatBody;
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_completion_tokens).toBe(100);
  });

  test("drops reasoning_effort for unknown providers (synthesized profiles fail closed)", async () => {
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest({
      model: { id: "test-model", provider: "not-a-real-provider", routeId: "test" },
      reasoning: true,
      reasoningConfig: { effort: "high" },
    })) as OpenAIChat.OpenAIChatBody;
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("keeps json_schema when structuredOutputStrict is set", async () => {
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest({
      schema: { type: "object" },
      structuredOutputStrict: true,
    })) as OpenAIChat.OpenAIChatBody;
    expect(body.response_format).toBeDefined();
    expect(body.response_format!.type).toBe("json_schema");
    expect((body.response_format as { json_schema: { strict: boolean } }).json_schema.strict).toBe(true);
  });

  test("downgrades json_schema to json_object without structuredOutputStrict", async () => {
    // The in-prompt schema fallback (llm-direct) carries the contract for
    // providers that 400 on strict json_schema mode — the wire downgrade must
    // pair with that fallback, never drop the schema silently.
    const body = await OpenAICompatibleChat.protocol.body.from(makeRequest({ schema: { type: "object" } })) as OpenAIChat.OpenAIChatBody;
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});

// ─── Anthropic Messages protocol ────────────────────────────────────────────

describe("AnthropicMessages.protocol — body construction", () => {
  test("extracts system message into the `system` field", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest()) as AnthropicMessages.AnthropicBody;
    expect(body.system).toBeDefined();
    expect(body.system).toHaveLength(1);
    expect(body.system![0].text).toBe("You are a test assistant.");
    // A stateless one-shot call (one system + one user) never re-reads its own
    // cache write, so cache_control is omitted (no cache-write premium).
    expect(body.system![0].cache_control).toBeUndefined();
  });

  test("omits system when no system message", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      messages: [{ role: "user", content: "Hi" }],
    })) as AnthropicMessages.AnthropicBody;
    expect(body.system).toBeUndefined();
  });

  test("extracts <screenshot> marker into an image content block", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: 'See this: <screenshot>data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==</screenshot>' },
      ],
    })) as AnthropicMessages.AnthropicBody;
    const userContent = body.messages[0].content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
    expect(userContent).toHaveLength(2);
    expect(userContent[0].type).toBe("text");
    expect(userContent[0].text).toBe("See this:");
    expect(userContent[1].type).toBe("image");
    expect(userContent[1].source?.media_type).toBe("image/png");
    expect(userContent[1].source?.data).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==");
  });

  test("forces tool_use for structured output when a schema is provided", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ schema: { type: "object" } } as Partial<LLMRequest>)) as AnthropicMessages.AnthropicBody;
    expect(body.tools).toBeDefined();
    expect(body.tools![0].name).toBe("return_json");
    expect(body.tool_choice).toEqual({ type: "tool", name: "return_json" });
  });

  test("rejects a <screenshot> marker whose payload fails the provenance check", async () => {
    const badPayload = "/9j/AAAA";
    await expect(
      AnthropicMessages.protocol.body.from(makeRequest({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: `See: <screenshot>data:image/png;base64,${badPayload}</screenshot>` },
        ],
      }))
    ).rejects.toThrow(/provenance check/);
  });

  test("default max_tokens is 4096", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ generation: { temperature: 0 } } as Partial<LLMRequest>)) as AnthropicMessages.AnthropicBody;
    expect(body.max_tokens).toBe(4096);
  });

  test("emits a thinking block with the derived budget when only effort is configured", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      generation: { maxTokens: 64000 },
      reasoning: true,
      reasoningConfig: { effort: "high" },
    })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
    expect(body.temperature).toBeUndefined();
  });

  test("derives the thinking budget as min(16_000, output/2-1)", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      generation: { maxTokens: 8192 },
      reasoning: true,
      reasoningConfig: { enabled: true },
    })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 });
  });

  test("clamps an explicit thinking budget to min(31_999, output-1)", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      generation: { maxTokens: 8192 },
      reasoning: true,
      reasoningConfig: { budgetTokens: 16000 },
    })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8191 });
  });

  test("passes an explicit thinking budget through when under the cap", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      generation: { maxTokens: 64000 },
      reasoning: true,
      reasoningConfig: { budgetTokens: 30000 },
    })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 30000 });
  });

  test("emits thinking:disabled when reasoning is forced off", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      reasoning: true,
      reasoningConfig: { enabled: false },
    })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBe(0);
  });

  test("keeps today's body when no reasoning config is set", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ reasoning: true })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  test("ignores reasoning config on non-reasoning providers", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      reasoning: false,
      reasoningConfig: { budgetTokens: 16000 },
    })) as AnthropicMessages.AnthropicBody;
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0);
  });

  test("keeps cache_control '1h' when the request is cache-eligible", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ cacheEligible: true })) as AnthropicMessages.AnthropicBody;
    expect(body.system![0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("keeps cache_control '1h' for multi-message conversations", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
    })) as AnthropicMessages.AnthropicBody;
    expect(body.system![0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("omits cache_control on the tools block for one-shot non-eligible requests", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ schema: { type: "object" } } as Partial<LLMRequest>)) as AnthropicMessages.AnthropicBody;
    expect(body.tools![0].cache_control).toBeUndefined();
  });

  test("keeps cache_control '1h' on the tools block when cache-eligible", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ schema: { type: "object" }, cacheEligible: true } as Partial<LLMRequest>)) as AnthropicMessages.AnthropicBody;
    expect(body.tools![0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

describe("AnthropicMessages.protocol — stream parsing", () => {
  test("accumulates text from content_block_delta events", async () => {
    // Realistic Anthropic SSE sequence:
    // message_start → carries input_tokens (and initial output_tokens) under
    // `data.message.usage`.
    // content_block_delta × N → carries text deltas.
    // message_delta → carries ONLY `output_tokens` (cumulative). Has no
    // input_tokens field at all.
    // message_stop → terminal; finish event uses the accumulated usage.
    const frames = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: ", world!" } }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const { content, terminatedEarly } = reduceFrames(AnthropicMessages.protocol, frames, makeRequest());
    expect(content).toBe("Hello, world!");
    expect(terminatedEarly).toBe(true);
  });

  test("terminal returns false for non-terminal events", async () => {
    expect(AnthropicMessages.protocol.stream.terminal?.(JSON.stringify({ type: "content_block_delta" }))).toBe(false);
    expect(AnthropicMessages.protocol.stream.terminal?.(JSON.stringify({ type: "message_delta" }))).toBe(false);
    expect(AnthropicMessages.protocol.stream.terminal?.(JSON.stringify({ type: "message_start" }))).toBe(false);
  });

  test("terminal returns true for message_stop", async () => {
    expect(AnthropicMessages.protocol.stream.terminal?.(JSON.stringify({ type: "message_stop" }))).toBe(true);
  });

  test("non-JSON frame is not terminal", async () => {
    expect(AnthropicMessages.protocol.stream.terminal?.("not json")).toBe(false);
  });

  test("captures input_tokens from message_start (not message_delta)", async () => {
    // Anthropic sends input_tokens in `message_start.data.message.usage`,
    // NOT in `message_delta`. Reading `input_tokens` from
    // `message_delta.data.usage` would always be undefined → tokensIn
    // would always be 0 → cost tracking broken. This test drives the realistic
    // SSE frame order to assert input_tokens survives into the finish event.
    const frames = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 0 } } }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const { events } = reduceFrames(AnthropicMessages.protocol, frames, makeRequest());
    const finish = events.find((e) => (e as { type?: string }).type === "finish") as
      | { type: string; usage?: { tokensIn: number; tokensOut: number } }
      | undefined;
    expect(finish).toBeDefined();
    expect(finish?.usage).toBeDefined();
    expect(finish?.usage?.tokensIn).toBe(42);
    expect(finish?.usage?.tokensOut).toBe(7);
  });

  test("message_delta does not overwrite tokensIn with 0", async () => {
    // If a stream happens to lack a message_start event, the message_delta
    // handler must NOT zero out any previously captured tokensIn. Drive two
    // message_delta events back-to-back and confirm tokensIn (if set) is
    // preserved rather than clobbered.
    const state0 = AnthropicMessages.protocol.stream.initial(makeRequest()) as AnthropicMessages.StreamState;
    state0.usage = { tokensIn: 99, tokensOut: 0, model: "", costUsd: 0 };
    const { state: after } = AnthropicMessages.protocol.stream.step(
      state0,
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } }),
    );
    expect((after as AnthropicMessages.StreamState).usage?.tokensIn).toBe(99);
    expect((after as AnthropicMessages.StreamState).usage?.tokensOut).toBe(5);
  });

  test("cache_read + cache_creation tokens folded into tokensIn (total) + cachedInputTokens", async () => {
    // Anthropic's `input_tokens` is FRESH-only (disjoint from cache_read +
    // cache_creation), unlike OpenAI's `prompt_tokens` which is the TOTAL.
    // The protocol sets `tokensIn = input_tokens + cache_read + cache_creation`
    // so `pricing.ts`'s `cached = Math.min(cached, tokensIn)` clamp (which
    // assumes cached ⊆ tokensIn, OpenAI semantics) works correctly:
    // freshInput = tokensIn - cached = (42+100+50) - 150 = 42 (fresh-only ✓)
    // cached = 150 (billed at cacheReadRate ✓)
    // Without this, `tokensIn` would be just 42, the clamp would zero out
    // `cached` (min(150, 42) = 42), and 108 cached tokens would be silently
    // dropped from cost accounting — under-reporting Anthropic cached-step cost.
    const frames = [
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 42,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            output_tokens: 0,
          },
        },
      }),
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const { events } = reduceFrames(AnthropicMessages.protocol, frames, makeRequest());
    const finish = events.find((e) => (e as { type?: string }).type === "finish") as
      | { type: string; usage?: { tokensIn: number; tokensOut: number; cachedInputTokens?: number; cachedWriteInputTokens?: number } }
      | undefined;
    expect(finish).toBeDefined();
    expect(finish?.usage).toBeDefined();
    // Total input = fresh (42) + cache_read (100) + cache_creation (50) = 192
    expect(finish?.usage?.tokensIn).toBe(192);
    // cachedInputTokens = cache_read (100); cache_creation is now reported
    // separately as cachedWriteInputTokens (50), billed at the cacheWrite rate.
    expect(finish?.usage?.cachedInputTokens).toBe(100);
    expect(finish?.usage?.cachedWriteInputTokens).toBe(50);
    expect(finish?.usage?.tokensOut).toBe(7);
  });

  test("cachedInputTokens is preserved across message_delta (not clobbered to 0)", async () => {
    // message_delta only carries output_tokens — it must NOT zero out the
    // cachedInputTokens captured by message_start. Same invariant as the
    // tokensIn preservation test above, applied to cachedInputTokens.
    const state0 = AnthropicMessages.protocol.stream.initial(makeRequest()) as AnthropicMessages.StreamState;
    state0.usage = { tokensIn: 200, tokensOut: 0, model: "", costUsd: 0, cachedInputTokens: 150 };
    const { state: after } = AnthropicMessages.protocol.stream.step(
      state0,
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } }),
    );
    expect((after as AnthropicMessages.StreamState).usage?.tokensIn).toBe(200);
    expect((after as AnthropicMessages.StreamState).usage?.cachedInputTokens).toBe(150);
    expect((after as AnthropicMessages.StreamState).usage?.tokensOut).toBe(5);
  });
});

// ─── Gemini protocol ────────────────────────────────────────────────────────

describe("Gemini.protocol — body construction", () => {
  test("builds contents with role mapping (assistant → model)", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ],
    })) as Gemini.GeminiBody;
    expect(body.contents).toHaveLength(2);
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[1].role).toBe("model"); // assistant → model
  });

  test("extracts system instruction", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi" },
      ],
    })) as Gemini.GeminiBody;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be helpful." }] });
  });

  test("extracts <screenshot> marker into inline_data", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: 'See: <screenshot>data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==</screenshot>' },
      ],
    })) as Gemini.GeminiBody;
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("See:");
    expect(parts[1].inline_data).toEqual({ mime_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==" });
  });

  test("rejects a <screenshot> marker whose payload fails the provenance check", async () => {
    const badPayload = "/9j/AAAA";
    await expect(
      Gemini.protocol.body.from(makeRequest({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: `See: <screenshot>data:image/png;base64,${badPayload}</screenshot>` },
        ],
      }))
    ).rejects.toThrow(/provenance check/);
  });

  test("sets responseSchema when a schema is provided", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({ schema: { type: "object" } } as Partial<LLMRequest>)) as Gemini.GeminiBody;
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({ type: "object" });
  });

  test("real Zod schema with .default() fields survives the strict path (no ~standard rejection)", async () => {
    // zod v4 toJSONSchema output carries a non-enumerable `~standard` property,
    // which made isPlainJSONSchema reject every real Zod schema and throw.
    // The JSON round-trip strips it; the schema must pass through unmodified.
    const ZodSchemaWithDefaults = z.object({
      thinking: z.string().default(""),
      next_goal: z.string().default(""),
      done: z.boolean().default(false),
      count: z.number().optional().default(3),
    });
    const body = await Gemini.protocol.body.from(makeRequest({
      schema: ZodSchemaWithDefaults,
    } as Partial<LLMRequest>)) as Gemini.GeminiBody;
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    const schema = body.generationConfig.responseSchema as Record<string, unknown>;
    expect(typeof schema).toBe("object");
    expect("~standard" in schema).toBe(false);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  test("default maxOutputTokens is 8192", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({ generation: { temperature: 0 } } as Partial<LLMRequest>)) as Gemini.GeminiBody;
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

  test("omits temperature for reasoning requests (Gemini 3.x rejects it)", async () => {
    // Google deprecates temperature/top_p/top_k on Gemini 3.x reasoning models
    // and returns HTTP 400 for them on future generations. The sibling
    // protocols (openai-chat, anthropic-messages-utils) gate temperature on
    // `request.reasoning`; gemini must do the same.
    const body = await Gemini.protocol.body.from(makeRequest({ reasoning: true })) as Gemini.GeminiBody;
    expect(body.generationConfig.temperature).toBeUndefined();
    // The output budget is still sent (it is the thinking budget on reasoning models).
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  test("keeps temperature for non-reasoning requests", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({ reasoning: false })) as Gemini.GeminiBody;
    expect(body.generationConfig.temperature).toBe(0);
  });

  test("adds thinkingConfig.thinkingBudget when a budget is configured", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({
      reasoning: true,
      reasoningConfig: { budgetTokens: 16000 },
    })) as Gemini.GeminiBody;
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 16000 });
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  test("clamps an oversized thinking budget to the Gemini max (32768)", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({
      reasoning: true,
      reasoningConfig: { budgetTokens: 1e12 },
    })) as Gemini.GeminiBody;
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 32768 });
  });

  test("omits thinkingConfig without a budget", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({ reasoning: true, reasoningConfig: { enabled: true } })) as Gemini.GeminiBody;
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  test("respects enabled:false (restores temperature, no thinkingConfig)", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({
      reasoning: true,
      reasoningConfig: { budgetTokens: 16000, enabled: false },
    })) as Gemini.GeminiBody;
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.generationConfig.temperature).toBe(0);
  });

  test("geminiPath embeds the model id in the URL path", async () => {
    expect(Gemini.geminiPath("gemini-2.0-flash")).toBe("/gemini-2.0-flash:streamGenerateContent");
  });

  test("geminiPath throws on a structurally-invalid model id (injection guard)", () => {
    // Model ids containing path separators / query metacharacters are rejected
    // so they can't rewrite the request URL. encodeURIComponent would also
    // neutralize them, but we fail fast on malformed ids.
    expect(() => Gemini.geminiPath("weird/model id?x=1")).toThrow(/Invalid model id/);
    expect(() => Gemini.geminiPath("bad\tid")).toThrow(/Invalid model id/);
    expect(() => Gemini.geminiPath("")).toThrow(/Invalid model id/);
  });
});

// ─── Model-id URL encoding/validation ─────────────────────────────────

describe("encodeModelIdForUrl — safe URL encoding + validation", () => {
  test("leaves normal model ids untouched", () => {
    expect(encodeModelIdForUrl("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(encodeModelIdForUrl("gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(encodeModelIdForUrl("claude-3-7-sonnet-20250219")).toBe("claude-3-7-sonnet-20250219");
  });

  test("percent-encodes characters encodeURIComponent touches (e.g. ':')", () => {
    // `:` is a valid model-id char per the allow-list but is percent-encoded
    // by encodeURIComponent, so it can't be misinterpreted in the URL path.
    expect(encodeModelIdForUrl("ns:model")).toBe("ns%3Amodel");
  });

  test("throws on structurally-invalid model ids", () => {
    expect(() => encodeModelIdForUrl("has space")).toThrow(/Invalid model id/);
    expect(() => encodeModelIdForUrl("slash/in/id")).toThrow(/Invalid model id/);
    expect(() => encodeModelIdForUrl("tab\tchar")).toThrow(/Invalid model id/);
    expect(() => encodeModelIdForUrl("")).toThrow(/Invalid model id/);
  });

  test("rejects path-traversal ids ('..' / embedded '..') so the URL path can't be rewritten", () => {
    // The `[\w.:-]+` allow-list PERMITS dots, so `..` passes the regex and is
    // caught only by the explicit `model.includes("..")` guard. Assert it
    // throws, and that a single dotted segment like "a.b" is still allowed.
    expect(() => encodeModelIdForUrl("..")).toThrow(/Invalid model id/);
    expect(() => encodeModelIdForUrl("a..b")).toThrow(/Invalid model id/);
    expect(encodeModelIdForUrl("a.b")).toBe("a.b");
  });

  test("rejects traversal/control forms that slip past a naive allow-list", () => {
    // Percent-encoded traversal ("..%2f") is NOT in the `[\w.:-]+` allow-list,
    // so the regex rejects it (the URL path can't be rewritten via encoding).
    expect(() => encodeModelIdForUrl("..%2f")).toThrow(/Invalid model id/);
    // A literal segmented traversal.
    expect(() => encodeModelIdForUrl("a/../b")).toThrow(/Invalid model id/);
    // Backslash and null byte are outside the allow-list and must throw.
    expect(() => encodeModelIdForUrl("a" + String.fromCharCode(92) + "b")).toThrow(/Invalid model id/);
    expect(() => encodeModelIdForUrl("a" + String.fromCharCode(0) + "b")).toThrow(/Invalid model id/);
  });
});

// ─── hasImageProvenance (screenshot-smuggling guard) ─────────────────────────

describe("hasImageProvenance — screenshot provenance guard", () => {
  test("accepts a payload whose magic bytes match the declared media type", () => {
    expect(hasImageProvenance("iVBORw0KGgo", "png")).toBe(true);
    expect(hasImageProvenance("/9j/AAAA", "jpeg")).toBe(true);
    expect(hasImageProvenance("UklGR", "webp")).toBe(true);
  });

  test("rejects a payload whose magic bytes DON'T match the declared type", () => {
    // Declared png but JPEG bytes: the guard must reject (this is the
    // injection-smuggling defense).
    expect(hasImageProvenance("/9j/AAAA", "png")).toBe(false);
    // Declared jpeg but PNG bytes.
    expect(hasImageProvenance("iVBORw0KGgo", "jpeg")).toBe(false);
    // Random / non-image bytes.
    expect(hasImageProvenance("notreallyanimage", "png")).toBe(false);
  });

  test("rejects an unknown/unsupported media type", () => {
    expect(hasImageProvenance("iVBORw0KGgo", "gif")).toBe(false);
  });
});

// ─── isValidCatalog (trust-boundary guard) ───────────────────────────────────

describe("isValidCatalog — catalog trust-boundary guard", () => {
  const validProvider = () => ({
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        release_date: "2024-05-13",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: { input: 2.5, output: 10 },
      },
    },
  });

  test("accepts a well-formed minimal catalog entry", () => {
    expect(isValidCatalog({ openai: validProvider() })).toBe(true);
  });

  test("rejects a negative input cost (would defeat the cost cap)", () => {
    const c = validProvider();
    (c.models["gpt-4o"] as { cost: { input: number; output: number } }).cost = { input: -1, output: 10 };
    expect(isValidCatalog({ openai: c })).toBe(false);
  });

  test("accepts a zero cost (legitimate free-tier model, must not be mistaken for a negative/invalid cost)", () => {
    const c = validProvider();
    (c.models["gpt-4o"] as { cost: { input: number; output: number } }).cost = { input: 0, output: 0 };
    expect(isValidCatalog({ openai: c })).toBe(true);
  });

  test("rejects a non-numeric cost", () => {
    const c = validProvider();
    (c.models["gpt-4o"] as { cost: { input: unknown; output: number } }).cost = { input: "x", output: 10 };
    expect(isValidCatalog({ openai: c })).toBe(false);
  });

  test("rejects a non-finite cost (NaN/Infinity would poison the cost cap)", () => {
    // typeof NaN and typeof Infinity are both "number", so the guard must
    // check Number.isFinite, not just type. The secondary rate fields
    // (cache_write, input_audio, …) went through a typeof-only check.
    const c = validProvider();
    (c.models["gpt-4o"] as { cost: Record<string, unknown> }).cost = { input: 1, output: 1, cache_write: Number.POSITIVE_INFINITY };
    expect(isValidCatalog({ openai: c })).toBe(false);
    (c.models["gpt-4o"] as { cost: Record<string, unknown> }).cost = { input: 1, output: 1, input_audio: Number.NaN };
    expect(isValidCatalog({ openai: c })).toBe(false);
  });

  test("rejects a missing/non-string release_date (would crash the picker)", () => {
    const c = validProvider();
    (c.models["gpt-4o"] as { release_date: unknown }).release_date = 20240101;
    expect(isValidCatalog({ openai: c })).toBe(false);
  });

  test("rejects a missing/non-string id or name", () => {
    const c = validProvider();
    (c as { id: unknown }).id = 123;
    expect(isValidCatalog({ openai: c })).toBe(false);
  });
});

describe("model catalog cache key convention", () => {
  test("CACHE_KEY follows the project's open_cowork_ storage prefix", () => {
    // Storage keys are the one namespace users may see; the __opencowork_
    // double-underscore prefix diverges from the open_cowork_ convention
    // used by every other storage key in the extension.
    expect(CACHE_KEY).toMatch(/^open_cowork_/);
  });
});

describe("Gemini.protocol — stream parsing", () => {
  test("accumulates text from candidates[].content.parts[]", async () => {
    const frames = [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: ", world!" }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } }),
    ];
    const { content, terminatedEarly } = reduceFrames(Gemini.protocol, frames, makeRequest());
    expect(content).toBe("Hello, world!");
    expect(terminatedEarly).toBe(true); // terminal on the usageMetadata frame
  });

  test("terminal returns true on finishReason (primary signal)", async () => {
    expect(Gemini.protocol.stream.terminal?.(JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] }))).toBe(true);
    expect(Gemini.protocol.stream.terminal?.(JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }] }))).toBe(true);
  });

  test("terminal returns false on FINISH_REASON_UNSPECIFIED (intermediate)", async () => {
    expect(Gemini.protocol.stream.terminal?.(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "FINISH_REASON_UNSPECIFIED" }] }))).toBe(false);
  });

  test("terminal returns false on intermediate chunks without finishReason or usageMetadata", async () => {
    expect(Gemini.protocol.stream.terminal?.(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }))).toBe(false);
  });

  test("terminal returns true on usageMetadata (fallback for older API versions)", async () => {
    expect(Gemini.protocol.stream.terminal?.(JSON.stringify({ usageMetadata: {} }))).toBe(true);
  });
});

// ─── resolveVisionSupport (vision/screenshot gating) ────────────────────────

describe("resolveVisionSupport — modelSupportsVision gating logic", () => {
  // Build a minimal but well-formed CatalogModel. `attachment` defaults to
  // false (the safe default) so each test opts a model INTO vision
  // explicitly.
  function model(overrides: Partial<CatalogModel> & { id: string }): CatalogModel {
    const { id, ...rest } = overrides;
    return {
      name: id,
      release_date: "2024-01-01",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      cost: { input: 1, output: 1 },
      ...rest,
      id,
    };
  }

  test("exact match with attachment:false reports NOT vision", () => {
    const models = [model({ id: "gpt-4", attachment: false })];
    expect(resolveVisionSupport("gpt-4", models)).toBe(false);
  });

  test("exact match with attachment:true reports vision", () => {
    const models = [model({ id: "gpt-4o", attachment: true })];
    expect(resolveVisionSupport("gpt-4o", models)).toBe(true);
  });

  test("exact match with modalities.input 'image' reports vision", () => {
    const models = [model({ id: "claude-3-opus", modalities: { input: ["image"] } })];
    expect(resolveVisionSupport("claude-3-opus", models)).toBe(true);
  });

  test("requested base id as substring of a vision-only variant is NOT treated as vision", () => {
    // 'gpt-4' is a prefix of
    // 'gpt-4-vision-preview', but the base model is NOT a vision model, so the
    // screenshot must NOT be attached (it would 400 on a non-vision model).
    const models = [model({ id: "gpt-4-vision-preview", attachment: true })];
    expect(resolveVisionSupport("gpt-4", models)).toBe(false);
  });

  test("dated variant of the same vision model IS treated as vision (substring still works)", () => {
    // The case substring matching is supposed to serve: the user typed
    // 'gpt-4o' but the catalog carries only the dated 'gpt-4o-2024-08-06'.
    const models = [model({ id: "gpt-4o-2024-08-06", attachment: true })];
    expect(resolveVisionSupport("gpt-4o", models)).toBe(true);
  });

  test("no catalog models falls back to the name heuristic (vision family)", () => {
    // Catalog unavailable / provider-less: 'claude-3-opus' must still resolve
    // to vision via VISION_PATTERNS, not throw or default to false.
    expect(resolveVisionSupport("claude-3-opus", [])).toBe(true);
  });

  test("non-vision name with no catalog falls back to the heuristic (false)", () => {
    expect(resolveVisionSupport("text-embedding-3-small", [])).toBe(false);
  });

  test("ambiguous substring that matches a non-vision base variant is not vision", () => {
    // 'gpt-4' substring-matches a dated NON-vision base variant; since the base
    // isn't vision, the heuristic (which doesn't cover 'gpt-4') yields false.
    const models = [model({ id: "gpt-4-2024-08-06", attachment: false })];
    expect(resolveVisionSupport("gpt-4", models)).toBe(false);
  });

  test("exact catalog entry with explicit attachment:false beats the name heuristic", () => {
    // 'claude-3-opus' matches VISION_PATTERNS ('\bclaude-3\b'), but the catalog
    // explicitly declares attachment:false for this exact id. The explicit
    // statement must win — the heuristic is only a fallback for models the
    // catalog has no opinion about.
    const models = [model({ id: "claude-3-opus", attachment: false })];
    expect(resolveVisionSupport("claude-3-opus", models)).toBe(false);
  });

  test("modalities input 'image' still reports vision even when attachment is false", () => {
    // The modalities field is an explicit signal; it is not overridden by the
    // attachment default.
    const models = [model({ id: "claude-3-opus", attachment: false, modalities: { input: ["image"] } })];
    expect(resolveVisionSupport("claude-3-opus", models)).toBe(true);
  });
});

// ─── isPlainJSONSchema (moved to shared-image) ──────────────────────────────

describe("isPlainJSONSchema — plainness guard for strict schemas", () => {
  test("accepts a plain JSON Schema object", () => {
    expect(isPlainJSONSchema({ type: "object", properties: {} })).toBe(true);
  });

  test("rejects a raw Zod schema object (safeParse + ~standard)", () => {
    const schema = z.object({ a: z.string() });
    expect(isPlainJSONSchema(schema)).toBe(false);
  });

  test("rejects zod v4 toJSONSchema output until JSON round-tripped (~standard)", () => {
    const converted = z.toJSONSchema(z.object({ a: z.string().default("") })) as Record<string, unknown>;
    expect("~standard" in converted).toBe(true);
    expect(isPlainJSONSchema(converted)).toBe(false);
    expect(isPlainJSONSchema(JSON.parse(JSON.stringify(converted)))).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(isPlainJSONSchema("str")).toBe(false);
    expect(isPlainJSONSchema(null)).toBe(false);
  });
});

// ─── normalizeStrictSchema default stripping ────────────────────────────────

describe("normalizeStrictSchema default stripping", () => {
  test("strips `default` from a plain schema sent through the strict protocol body", async () => {
    const body = await OpenAIChat.protocol.body.from(makeRequest({
      schema: {
        type: "object",
        properties: {
          goal: { type: "string", default: "" },
          done: { type: "boolean", default: false },
        },
      },
    } as Partial<LLMRequest>)) as OpenAIChat.OpenAIChatBody;
    const js = (body.response_format as { json_schema: { schema: Record<string, unknown>; strict: boolean } }).json_schema;
    expect(js.strict).toBe(true);
    expect(JSON.stringify(js.schema)).not.toContain('"default"');
  });

  test("strips `default` emitted by a real Zod schema with .default() fields", async () => {
    // Transform-free Zod schema (zodToJsonSchema rejects transform-based
    // schemas, e.g. the flexibleBoolean helper) so the strict path is
    // exercised end-to-end: isZodSchema → toJSONSchema → normalizeStrictSchema.
    const ZodSchemaWithDefaults = z.object({
      thinking: z.string().default(""),
      next_goal: z.string().default(""),
      done: z.boolean().default(false),
      count: z.number().optional().default(3),
    });
    const body = await OpenAIChat.protocol.body.from(makeRequest({
      schema: ZodSchemaWithDefaults,
    } as Partial<LLMRequest>)) as OpenAIChat.OpenAIChatBody;
    const js = (body.response_format as { json_schema: { schema: Record<string, unknown>; strict: boolean } }).json_schema;
    expect(js.strict).toBe(true);
    expect(JSON.stringify(js.schema)).not.toContain('"default"');
  });

  test("strips nested `default` nodes (nullable anyOf branches, array items, $defs, object properties)", () => {
    const normalized = normalizeStrictSchema({
      type: "object",
      properties: {
        n: { type: ["string", "null"], default: "x" },
        tags: { type: "array", items: { type: "string", default: "t" }, default: [] },
        nested: {
          type: "object",
          properties: { a: { type: "string", default: "a" } },
          default: {},
        },
      },
      $defs: { d: { type: "string", default: "d" } },
    });
    expect(JSON.stringify(normalized)).not.toContain('"default"');
  });
});

// ─── azure facade: path-prefixed baseURL must survive ────────────────────────

describe("azure facade baseURL path prefix", () => {
  test("a path-prefixed baseURL is preserved in the deployment URL", async () => {
    // The transport's DNS recheck fails closed without a resolver; shim a
    // public IP so the generate-based test reaches the mocked fetch.
    const g = globalThis as unknown as { chrome?: unknown };
    const savedFetch = globalThis.fetch;
    const savedChrome = g.chrome;
    try {
      g.chrome = {
        runtime: {},
        dns: { resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) => cb({ addresses: ["93.184.216.34"] }) },
      };
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        type: "basic",
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const cfg = configureAzure({ baseURL: "https://example.org/proxy", apiKey: "k", apiVersion: "2024-10-21" });
      const model = cfg.model("gpt-4o");
      await generate({ model, messages: [{ role: "user", content: "hi" }] });
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      // buildURL's `new URL(path, base)` replaces the base PATH for a
      // leading-slash path — the facade must split origin + prefix so a
      // proxied Azure endpoint (`https://{resource}.openai.azure.com/prefix`)
      // doesn't silently hit the unprefixed URL (404/401).
      expect(url).toContain("https://example.org/proxy/openai/deployments/gpt-4o/chat/completions");
    } finally {
      globalThis.fetch = savedFetch;
      if (savedChrome === undefined) delete g.chrome;
      else g.chrome = savedChrome;
    }
  });
});
