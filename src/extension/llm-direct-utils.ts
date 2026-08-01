import type { HistoryItem } from "../lib/agent/types";
import { SCREENSHOT_PATTERN_G } from "@/lib/agent/llm/shared-image";

/** Map a provider chat response's `content`/`usage` to the shape the
 * orchestrator expects from `navigatorCall`/`plannerCall`. */
export function extractUsage(r: {
  content: string;
  usage?: {
    tokensIn?: number;
    tokensOut?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    model?: string;
    costUsd?: number;
  };
}) {
  return {
    raw: r.content,
    tokensIn: r.usage?.tokensIn,
    tokensOut: r.usage?.tokensOut,
    reasoningTokens: r.usage?.reasoningTokens,
    cachedInputTokens: r.usage?.cachedInputTokens,
    model: r.usage?.model,
    costUsd: r.usage?.costUsd,
  };
}

/**
 * Cap `text` to `max` characters, appending a marker so the model knows data
 * was dropped. Guards `undefined` (treated as empty) so a missing field can
 * never throw on `.length`. Used for both elementsText and axTree.
 */
export function capText(text: string | undefined, max: number): string {
  const safe = text ?? "";
  return safe.length > max
    ? safe.slice(0, max) + `\n[... truncated at ${max} chars ...]`
    : safe;
}

/**
 * Strip any `<screenshot>data:image/...;base64,...</screenshot>` markers from
 * UNTRUSTED page-derived text BEFORE it is composed into the model input.
 *
 * Why: the protocol adapters (anthropic-messages / gemini / openai-chat) scan
 * every message's CONTENT for `SCREENSHOT_PATTERN_G` and turn each match into an
 * image block that is forwarded to the model. A malicious page can embed a
 * `<screenshot>` marker (with an attacker-chosen image) inside its AX tree,
 * interactive-element text, or extracted/summarized history. Because the
 * extension concatenates that untrusted text with its OWN trusted screenshot
 * marker, the adapter would happily attach the attacker's image too. `shared
 * -image.ts`'s `hasImageProvenance` only checks PNG magic bytes (trivially
 * forgeable), so it does not stop this.
 *
 * Stripping the marker from untrusted inputs means the ONLY `<screenshot>` that
 * survives into the content is the one `navigatorCallDirect` injects itself from
 * `req.browserState.screenshot` (the real captured pixels). The legitimate
 * screenshot feature is therefore untouched — we only remove markers that an
 * untrusted page could have forged.
 *
 * We build a fresh `g` regex from the adapters' pattern *source* so the strip
 * rule is guaranteed identical to the attach rule, and so we never share mutable
 * `lastIndex` state with the shared global regex object.
 */
export function stripScreenshotMarkers(text: string): string {
  if (!text) return text;
  return text.replace(new RegExp(SCREENSHOT_PATTERN_G.source, "g"), "");
}

/**
 * Strip screenshot markers from every page-derived string field of the agent's
 * run history. History can carry page content (e.g. `extract`-captured text,
 * evaluation/memory/goal summaries of a malicious page) that may contain an
 * injected `<screenshot>` marker. Returns a stripped COPY; the caller's history
 * array is never mutated.
 */
export function stripHistoryScreenshotMarkers(history: HistoryItem[]): HistoryItem[] {
  return history.map((h) => ({
    ...h,
    evaluation: stripScreenshotMarkers(h.evaluation),
    memory: stripScreenshotMarkers(h.memory),
    goal: stripScreenshotMarkers(h.goal),
    results: h.results.map((r) => ({
      ...r,
      message: stripScreenshotMarkers(r.message),
      extractedContent: r.extractedContent
        ? stripScreenshotMarkers(r.extractedContent)
        : r.extractedContent,
    })),
  }));
}
