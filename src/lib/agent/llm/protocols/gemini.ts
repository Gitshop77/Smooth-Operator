/**
 * Google Gemini protocol — implements the
 * `packages/llm/src/protocols/gemini.ts`.
 *
 * Implements the `:generateContent` + `:streamGenerateContent` API format
 * with support for vision (inline_data), structured output (responseSchema),
 * and system instruction.
 */

import { Protocol, type LLMRequest } from "../route/client";

const ADAPTER = "gemini";
export const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const PATH = ":streamGenerateContent";

const SCREENSHOT_PATTERN = /<screenshot>(data:image\/(png|jpeg|webp);base64,[^<]+)<\/screenshot>/;

export interface GeminiBody {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  generationConfig: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
  };
  systemInstruction?: { parts: Array<{ text: string }> };
}

async function fromRequest(request: LLMRequest): Promise<GeminiBody> {
  const systemMsg = request.messages.find((m) => m.role === "system");
  const userMessages = request.messages.filter((m) => m.role !== "system");

  // Only attach the image to the user message that CONTAINS the <screenshot>
  // marker — not every user message. Mirrors the OpenAI + Anthropic protocols.
  const contents = userMessages.map((m) => {
    const textContent = m.content.replace(/<screenshot>[^<]+<\/screenshot>/g, "").trim();
    if (m.role === "user") {
      const match = m.content.match(SCREENSHOT_PATTERN);
      if (match) {
        return {
          role: "user",
          parts: [
            { text: textContent },
            { inline_data: { mime_type: `image/${match[2]}`, data: match[1].split(",")[1] } },
          ],
        };
      }
    }
    return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: textContent }] };
  });

  const generationConfig: GeminiBody["generationConfig"] = {
    temperature: request.generation?.temperature ?? 0,
    maxOutputTokens: request.generation?.maxTokens ?? 8192,
  };
  if (request.schema) {
    // Serialize the Zod schema to a plain JSON Schema object before passing
    // to Gemini's responseSchema. The raw Zod schema object is not serializable.
    let jsonSchema: unknown = request.schema;
    try {
      const zNS = (await import("zod")).z as unknown as { toJSONSchema?: (s: unknown) => unknown };
      if (typeof zNS.toJSONSchema === "function") {
        jsonSchema = zNS.toJSONSchema(request.schema);
      }
    } catch { /* fall back to raw if z.toJSONSchema unavailable */ }
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = jsonSchema;
  }

  const body: GeminiBody = { contents, generationConfig };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  return body;
}

interface StreamState {
  content: string;
  usage?: { tokensIn: number; tokensOut: number; reasoningTokens?: number; cachedInputTokens?: number; model: string; costUsd: number };
}

export const protocol: Protocol<GeminiBody, string, { type: string; content?: string; usage?: StreamState["usage"] }, StreamState> = {
  id: ADAPTER,
  body: { from: fromRequest },
  stream: {
    initial: () => ({ content: "" }),
    step: (state: StreamState, frame: string) => {
      const events: Array<{ type: string; content?: string; usage?: StreamState["usage"] }> = [];
      try {
        const data = JSON.parse(frame);
        const parts = data.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const p of parts) {
            if (p.text) {
              state.content += p.text;
              events.push({ type: "text", content: p.text });
            }
          }
        }
        if (data.usageMetadata) {
          // Capture cachedContentTokenCount (cached → billed at cacheRead
          // rate) + thoughtsTokenCount (Gemini 2.5 Flash/Pro Thinking
          // reasoning tokens, billed at $0 without this → under-reporting
          // 30-60%).
          const cached = data.usageMetadata.cachedContentTokenCount;
          const reasoning = data.usageMetadata.thoughtsTokenCount;
          state.usage = {
            tokensIn: data.usageMetadata.promptTokenCount ?? 0,
            tokensOut: data.usageMetadata.candidatesTokenCount ?? 0,
            reasoningTokens: typeof reasoning === "number" && reasoning > 0 ? reasoning : undefined,
            cachedInputTokens: typeof cached === "number" && cached > 0 ? cached : undefined,
            model: "",
            costUsd: 0,
          };
        }
      } catch {
        // Non-JSON — skip
      }
      return { state, events };
    },
    terminal: (frame: string): boolean => {
      // Gemini sends usageMetadata only on the final chunk (confirmed
      // via API docs + community reports). But some edge cases (empty
      // responses with finishReason=STOP but no content) can also carry
      // usageMetadata. The safest terminal signal is finishReason on a
      // candidate — that's the API's explicit "I'm done" marker. We also
      // accept usageMetadata as a fallback for older API versions.
      try {
        const data = JSON.parse(frame);
        // Primary: check for finishReason on the first candidate
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") {
          return true;
        }
        // Fallback: usageMetadata presence (older API versions)
        if (data.usageMetadata) {
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
  },
};

/** Build the Gemini endpoint path for a specific model (uses dynamic path). */
export function geminiPath(model: string): string {
  // `encodeURIComponent` keeps normal ids identical (alphanumerics, ".", "-"
  // are left untouched) but prevents a malicious/garbage model id from
  // injecting path separators or query characters into the request URL.
  return `/${encodeURIComponent(model)}${PATH}`;
}

export * as Gemini from "./gemini";
