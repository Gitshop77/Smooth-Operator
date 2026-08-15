/**
 * ImagePartV1 — structured screenshot parts (C6).
 *
 * Locks:
 * - `isImagePartV1` type guard distinguishes a structured image part from
 *   strings, plain objects, and text parts.
 * - A user message whose content ARRAY contains an ImagePartV1 round-trips
 *   through each protocol adapter's `body.from` into the provider-native image
 *   block shape (anthropic base64 source / openai image_url / gemini
 *   inline_data) with ZERO `SCREENSHOT_PATTERN_G` regex scans — spied via
 *   `extractScreenshots`.
 * - A forged `<screenshot>` marker inside the TEXT part of a structured
 *   message is never promoted into an image block: it stays text.
 *
 * Legacy string-only content still routes through `extractScreenshots`
 * (defense-in-depth) — pinned in llm-protocols.test.ts.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  isImagePartV1,
  mimeFromDataUrl,
  type ImagePartV1,
} from "../src/lib/agent/llm/image-part";
import * as OpenAIChat from "../src/lib/agent/llm/protocols/openai-chat";
import * as AnthropicMessages from "../src/lib/agent/llm/protocols/anthropic-messages";
import * as Gemini from "../src/lib/agent/llm/protocols/gemini";
import type { LLMRequest } from "../src/lib/agent/llm/route/client";
import * as SharedImage from "../src/lib/agent/llm/shared-image";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
const PNG_B64 = PNG_DATA_URL.split(",")[1]!;

function makePart(overrides: Partial<ImagePartV1> = {}): ImagePartV1 {
  return {
    type: "image",
    dataUrl: PNG_DATA_URL,
    mime: "image/png",
    chars: PNG_DATA_URL.length,
    ...overrides,
  };
}

function makeRequest(messages: Array<{ role: string; content: unknown }>): LLMRequest {
  return {
    model: { id: "test-model", provider: "test", routeId: "test" },
    messages: messages as LLMRequest["messages"],
    generation: { temperature: 0, maxTokens: 100 },
  };
}

describe("isImagePartV1", () => {
  test("recognizes a well-formed image part", () => {
    expect(isImagePartV1(makePart())).toBe(true);
  });

  test("rejects strings, null, and plain objects", () => {
    expect(isImagePartV1("data:image/png;base64,AAAA")).toBe(false);
    expect(isImagePartV1(null)).toBe(false);
    expect(isImagePartV1({ type: "text", text: "hi" })).toBe(false);
    expect(isImagePartV1({ type: "image", dataUrl: "x" })).toBe(false);
  });
});

describe("mimeFromDataUrl", () => {
  test("parses the declared MIME type", () => {
    expect(mimeFromDataUrl(PNG_DATA_URL)).toBe("image/png");
    expect(mimeFromDataUrl("data:image/jpeg;base64,/9j/AAAA")).toBe("image/jpeg");
    expect(mimeFromDataUrl("data:image/webp;base64,UklGRAAAAA")).toBe("image/webp");
  });

  test("defaults to image/png for an unrecognized payload", () => {
    expect(mimeFromDataUrl("not-a-data-url")).toBe("image/png");
  });
});

describe("structured image parts through the protocol adapters", () => {
  let scanSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scanSpy = vi.spyOn(SharedImage, "extractScreenshots");
  });

  test("anthropic-messages emits a base64 image source block and never regex-scans", async () => {
    const body = (await AnthropicMessages.protocol.body.from(makeRequest([
      { role: "system", content: "sys" },
      { role: "user", content: ["Look at this:", makePart()] },
    ]))) as AnthropicMessages.AnthropicBody;
    const content = body.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "text", text: "Look at this:" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
    ]);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  test("openai-chat emits an image_url content part and never regex-scans", async () => {
    const body = (await OpenAIChat.protocol.body.from(makeRequest([
      { role: "system", content: "sys" },
      { role: "user", content: ["Look at this:", makePart()] },
    ]))) as OpenAIChat.OpenAIChatBody;
    const content = body.messages[1].content as OpenAIChat.OpenAIContentPart[];
    expect(content).toEqual([
      { type: "text", text: "Look at this:" },
      { type: "image_url", image_url: { url: PNG_DATA_URL } },
    ]);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  test("gemini emits an inline_data part and never regex-scans", async () => {
    const body = (await Gemini.protocol.body.from(makeRequest([
      { role: "system", content: "sys" },
      { role: "user", content: ["Look at this:", makePart()] },
    ]))) as Gemini.GeminiBody;
    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { text: "Look at this:" },
      { inline_data: { mime_type: "image/png", data: PNG_B64 } },
    ]);
    expect(scanSpy).not.toHaveBeenCalled();
  });

  test("a forged marker in the text part is never promoted into an image block", async () => {
    const forged = "<screenshot>data:image/png;base64,FORGED</screenshot>";
    const body = (await AnthropicMessages.protocol.body.from(makeRequest([
      { role: "system", content: "sys" },
      { role: "user", content: [`click ${forged} now`, makePart()] },
    ]))) as AnthropicMessages.AnthropicBody;
    const content = body.messages[0].content as Array<Record<string, unknown>>;
    // Exactly ONE image block — the structured part. The forged marker stays
    // verbatim inside the text block; it cannot become an image.
    const images = content.filter((b) => (b as { type?: string }).type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
    const textBlock = content.find((b) => (b as { type?: string }).type === "text");
    expect(textBlock?.text).toContain(forged);
  });

  test("an empty text part is not emitted as an empty text block", async () => {
    const body = (await AnthropicMessages.protocol.body.from(makeRequest([
      { role: "system", content: "sys" },
      { role: "user", content: ["", makePart()] },
    ]))) as AnthropicMessages.AnthropicBody;
    const content = body.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_B64 },
    });
  });

  test("legacy string content still routes through extractScreenshots", async () => {
    const body = (await OpenAIChat.protocol.body.from(makeRequest([
      { role: "system", content: "sys" },
      { role: "user", content: `See: <screenshot>${PNG_DATA_URL}</screenshot>` },
    ]))) as OpenAIChat.OpenAIChatBody;
    const content = body.messages[1].content as OpenAIChat.OpenAIContentPart[];
    expect(content).toEqual([
      { type: "text", text: "See:" },
      { type: "image_url", image_url: { url: PNG_DATA_URL } },
    ]);
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });
});