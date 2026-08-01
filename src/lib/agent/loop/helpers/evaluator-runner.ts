/**
 * Runs the deterministic evaluators (string / URL / HTML-content) against
 * the agent's final result + current page state.
 */

import type { AgentConfig } from "../../types";
import { EvaluatorComb, type EvaluatorKind } from "../../evaluators";
import type { LoopDeps, LoopState } from "../types";

type EvaluatorResult = {
  score: number;
  reasons: string[];
};

export async function runDeterministicEvaluators(
  deps: LoopDeps,
  config: AgentConfig,
  agentText: string,
  state: LoopState,
): Promise<EvaluatorResult | null> {
  const eo = config.expectedOutcomes;
  if (!eo) return null;
  const kinds: EvaluatorKind[] = [];
  if (eo.string && eo.string.length > 0) kinds.push("string_match");
  if (eo.url) kinds.push("url_match");
  if (eo.html && eo.html.length > 0) kinds.push("program_html");
  if (kinds.length === 0) return null;
  const comb = new EvaluatorComb(kinds);

  const input: Parameters<EvaluatorComb["evaluate"]>[0] = {};
  if (eo.string) {
    input.string = {
      prediction: agentText,
      referenceAnswers: eo.string.map((s) => ({
        type: s.type,
        ref: s.ref,
      })),
    };
  }
  if (eo.url) {
    let url: string;
    try {
      url = deps.getCurrentUrl ? await deps.getCurrentUrl() : (state.lastObservedUrl ?? "");
    } catch {
      url = state.lastObservedUrl ?? "";
    }
    input.url = {
      prediction: url,
      referenceUrl: eo.url.referenceUrl,
      matchingRule: eo.url.matchingRule,
    };
  }
  if (eo.html) {
    let pageHtml = "";
    if (deps.getPageHtml) {
      try {
        pageHtml = await deps.getPageHtml();
      } catch {
        pageHtml = "";
      }
    }
    input.html = {
      pageHtml,
      targets: eo.html.map((t) => ({
        locator: t.locator,
        required_contents: t.required_contents,
      })),
    };
  }

  const result = await comb.evaluate(input);
  return {
    score: result.score,
    reasons: result.reasons,
  };
}
