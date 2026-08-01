/**
 * Output parser — validates LLM JSON responses against Zod schemas.
 *
 * Replaces fragile string-slicing (which broke on JSON containing `}`) with
 * a tolerant extractor + Zod validation. On validation failure, returns a
 * structured error so the loop can retry with a "your last response was
 * invalid JSON" nudge.
 */

import { AgentOutputSchema, PlannerOutputSchema } from "./tools/schema";
import type { AgentOutput, PlannerOutput } from "./types";
import {
  type ParseResult,
  parseOutput,
} from "./output-parser-utils";

export { extractJson } from "./output-parser-utils";

/**
 * Parse a raw navigator LLM response into a validated {@link AgentOutput}.
 * Returns `{ ok: false, error }` on JSON, budget, or schema failure.
 */
export function parseAgentOutput(raw: string): ParseResult<AgentOutput> {
  return parseOutput(AgentOutputSchema, raw);
}

/**
 * Parse a raw planner LLM response into a validated {@link PlannerOutput}.
 * Returns `{ ok: false, error }` on JSON, budget, or schema failure.
 */
export function parsePlannerOutput(raw: string): ParseResult<PlannerOutput> {
  return parseOutput(PlannerOutputSchema, raw);
}
