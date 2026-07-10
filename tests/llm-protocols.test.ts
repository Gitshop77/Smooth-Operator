/**
 * LLM protocol tests — request-body construction + stream-frame parsing for
 * each wire protocol.
 *
 * Also provides the regression fixture for streaming truncation
 * (`finish_reason` check).
 */

import { describe, test, expect } from "vitest";
import * as OpenAIChat from "../src/lib/agent/llm/protocols/openai-chat";
import * as OpenAICompatibleChat from "../src/lib/agent/llm/protocols/openai-compatible-chat";
import * as AnthropicMessages from "../src/lib/agent/llm/protocols/anthropic-messages";
import * as Gemini from "../src/lib/agent/llm/protocols/gemini";
import { encodeModelIdForUrl } from "../src/lib/agent/llm/modelId";
import type { LLMRequest } from "../src/lib/agent/llm/route/client";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal LLMRequest the protocol's `body.from()` can consume. */
function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: { id: "test-model", provider: "test", route: {} as never, defaults: {} },
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
  protocol: any,
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
        { role: "user", content: 'See this: <screenshot>data:image/png;base64,iVBOR==</screenshot>' },
      ],
    })) as OpenAIChat.OpenAIChatBody;
    const userMsg = body.messages[1];
    // The content must be an array of parts, NOT a plain string.
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as OpenAIChat.OpenAIContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "See this:" });
    expect(parts[1].type).toBe("image_url");
    expect((parts[1] as { image_url: { url: string } }).image_url.url).toBe("data:image/png;base64,iVBOR==");
    // The raw base64 must NOT appear as prompt text anywhere.
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("image_url");
    // The data URL appears exactly once — inside the image_url part, not as text.
    expect((serialized.match(/data:image\/png;base64,iVBOR==/g) || []).length).toBe(1);
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
});

// ─── Anthropic Messages protocol ────────────────────────────────────────────

describe("AnthropicMessages.protocol — body construction", () => {
  test("extracts system message into the `system` field", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest()) as AnthropicMessages.AnthropicBody;
    expect(body.system).toBeDefined();
    expect(body.system).toHaveLength(1);
    expect(body.system![0].text).toBe("You are a test assistant.");
    // Prompt caching marker
    expect(body.system![0].cache_control).toEqual({ type: "ephemeral" });
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
        { role: "user", content: 'See this: <screenshot>data:image/png;base64,iVBOR==</screenshot>' },
      ],
    })) as AnthropicMessages.AnthropicBody;
    const userContent = body.messages[0].content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
    expect(userContent).toHaveLength(2);
    expect(userContent[0].type).toBe("text");
    expect(userContent[0].text).toBe("See this:");
    expect(userContent[1].type).toBe("image");
    expect(userContent[1].source?.media_type).toBe("image/png");
    expect(userContent[1].source?.data).toBe("iVBOR==");
  });

  test("forces tool_use for structured output when a schema is provided", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ schema: { type: "object" } } as Partial<LLMRequest>)) as AnthropicMessages.AnthropicBody;
    expect(body.tools).toBeDefined();
    expect(body.tools![0].name).toBe("return_json");
    expect(body.tool_choice).toEqual({ type: "tool", name: "return_json" });
  });

  test("default max_tokens is 4096", async () => {
    const body = await AnthropicMessages.protocol.body.from(makeRequest({ generation: { temperature: 0 } } as Partial<LLMRequest>)) as AnthropicMessages.AnthropicBody;
    expect(body.max_tokens).toBe(4096);
  });
});

describe("AnthropicMessages.protocol — stream parsing", () => {
  test("accumulates text from content_block_delta events", async () => {
    // Realistic Anthropic SSE sequence:
    //   message_start → carries input_tokens (and initial output_tokens) under
    //     `data.message.usage`.
    //   content_block_delta × N → carries text deltas.
    //   message_delta → carries ONLY `output_tokens` (cumulative). Has no
    //     input_tokens field at all.
    //   message_stop → terminal; finish event uses the accumulated usage.
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
    //   freshInput = tokensIn - cached = (42+100+50) - 150 = 42 (fresh-only ✓)
    //   cached = 150 (billed at cacheReadRate ✓)
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
      | { type: string; usage?: { tokensIn: number; tokensOut: number; cachedInputTokens?: number } }
      | undefined;
    expect(finish).toBeDefined();
    expect(finish?.usage).toBeDefined();
    // Total input = fresh (42) + cache_read (100) + cache_creation (50) = 192
    expect(finish?.usage?.tokensIn).toBe(192);
    // cachedInputTokens = cache_read + cache_creation = 150 (billed at cacheReadRate)
    expect(finish?.usage?.cachedInputTokens).toBe(150);
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
        { role: "user", content: 'See: <screenshot>data:image/png;base64,iVBOR==</screenshot>' },
      ],
    })) as Gemini.GeminiBody;
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("See:");
    expect(parts[1].inline_data).toEqual({ mime_type: "image/png", data: "iVBOR==" });
  });

  test("sets responseSchema when a schema is provided", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({ schema: { type: "object" } } as Partial<LLMRequest>)) as Gemini.GeminiBody;
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({ type: "object" });
  });

  test("default maxOutputTokens is 8192", async () => {
    const body = await Gemini.protocol.body.from(makeRequest({ generation: { temperature: 0 } } as Partial<LLMRequest>)) as Gemini.GeminiBody;
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

  test("geminiPath embeds the model id in the URL path", async () => {
    expect(Gemini.geminiPath("gemini-2.0-flash")).toBe("/gemini-2.0-flash:streamGenerateContent");
  });

  test("geminiPath throws on a structurally-invalid model id (F-23 — injection guard)", () => {
    // Model ids containing path separators / query metacharacters are rejected
    // so they can't rewrite the request URL. encodeURIComponent would also
    // neutralize them, but we fail fast on malformed ids.
    expect(() => Gemini.geminiPath("weird/model id?x=1")).toThrow(/Invalid model id/);
    expect(() => Gemini.geminiPath("bad\tid")).toThrow(/Invalid model id/);
    expect(() => Gemini.geminiPath("")).toThrow(/Invalid model id/);
  });
});

// ─── Model-id URL encoding/validation (F-23) ─────────────────────────────────

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
