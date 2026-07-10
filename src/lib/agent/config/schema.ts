/**
 * Centralized configuration validation using Zod.
 *
 * Provides a Zod schema for {@link AgentConfig} + a {@link validateConfig}
 * helper that produces a validated config (or throws a typed
 * {@link ConfigValidationError}).
 *
 * The schema mirrors the existing {@link AgentConfig} interface in
 * `../types.ts`. The validated output is structurally identical to what
 * `{ ...DEFAULT_CONFIG, ...userConfig }` produced before — the schema just
 * adds runtime validation at the boundary.
 *
 * Usage:
 *   import { validateConfig, type AgentConfigInput } from "@/lib/agent/config/schema";
 *   function createAgent(userConfig: Partial<AgentConfigInput>) {
 *     const merged = { ...DEFAULT_CONFIG, ...userConfig };
 *     const config = validateConfig(merged);
 *     // config is a fully-validated AgentConfig
 *   }
 *
 * The orchestrator calls {@link validateConfig} on every run. If validation
 * fails, it falls back to the plain spread-merge (backward-compatible — the
 * orchestrator never throws on bad config).
 */

import { z } from "zod";

// ─── Sub-schemas ────────────────────────────────────────────────────────────

/** Schema for a single string-match evaluator input. */
const StringMatchSchema = z.object({
  type: z.enum(["exact_match", "must_include", "regex"]),
  ref: z.string(),
});

/** Schema for the URL-match evaluator input. */
const UrlMatchSchema = z.object({
  referenceUrl: z.string(),
  matchingRule: z.literal("GOLD in PRED").optional(),
});

/** Schema for a single HTML-content evaluator target. */
const HtmlContentTargetSchema = z.object({
  locator: z.string().optional(),
  required_contents: z.object({
    exact_match: z.string().optional(),
    must_include: z.array(z.string()).optional(),
  }),
});

/** Schema for the expected-outcomes spec. */
const ExpectedOutcomesSchema = z.object({
  string: z.array(StringMatchSchema).optional(),
  url: UrlMatchSchema.optional(),
  html: z.array(HtmlContentTargetSchema).optional(),
});

/** Schema for the early-stop thresholds. */
const EarlyStopThresholdsSchema = z.object({
  parsingFailure: z.number().int().min(1).default(5),
  repeatingAction: z.number().int().min(1).default(3),
});

// ─── Main config schema ─────────────────────────────────────────────────────

/**
 * Zod schema for {@link AgentConfig}. Mirrors the interface in `../types.ts`.
 *
 * Defaults match {@link DEFAULT_CONFIG} from `../types.ts`:
 *   maxSteps: 100, maxActionsPerStep: 10, plannerInterval: 5, maxFailures: 5,
 *   enableLoopDetection: true, enableCompaction: true,
 *   compactionStepInterval: 20, compactionCharThreshold: 30_000,
 *   enableJudge: true.
 */
export const AgentConfigSchema = z.object({
  /** Hard step cap before forced stop (1-1000). */
  maxSteps: z.number().int().min(1).max(1000).default(100),
  /** Max actions the navigator can emit per step (1-50). */
  maxActionsPerStep: z.number().int().min(1).max(50).default(10),
  /** Run the planner every N navigator steps (>=1). */
  plannerInterval: z.number().int().min(1).default(5),
  /** Max consecutive failures before giving up (>=1). */
  maxFailures: z.number().int().min(1).default(5),
  /** Whether to enable loop detection. */
  enableLoopDetection: z.boolean().default(true),
  /** Whether to enable history compaction. */
  enableCompaction: z.boolean().default(true),
  /** Run compaction every N steps once threshold is met (>=1). */
  compactionStepInterval: z.number().int().min(1).default(20),
  /** Minimum history character length before compaction triggers (>=1000). */
  compactionCharThreshold: z.number().int().min(1000).default(30_000),
  /** Optional USD cost cap — aborts the run if exceeded. */
  costCapUsd: z.number().positive().optional(),
  /** Whether to run the judge LLM after the planner reports task success. */
  enableJudge: z.boolean().default(true),
  /** Whether to enable early-stop detection. */
  enableEarlyStop: z.boolean().optional(),
  /** Optional thresholds for the early-stop detector. */
  earlyStopThresholds: EarlyStopThresholdsSchema.optional(),
  /** Whether to run the HTML-summarizer pre-pass before each navigator call. */
  enableHtmlSummarizer: z.boolean().optional(),
  /** Optional expected-outcomes spec for deterministic evaluator fast-path. */
  expectedOutcomes: ExpectedOutcomesSchema.optional(),
});

/** Input type for {@link AgentConfigSchema} (accepts partial input). */
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;

/** Validated output type — structurally identical to {@link AgentConfig}. */
export type AgentConfigValidated = z.output<typeof AgentConfigSchema>;

// ─── Validation error ───────────────────────────────────────────────────────

/**
 * Thrown by {@link validateConfig} when the input fails schema validation.
 * Wraps the underlying ZodError in `cause` for structured inspection.
 */
export class ConfigValidationError extends Error {
  /** The Zod issues that caused the failure. */
  readonly issues: z.ZodIssue[];
  constructor(cause: z.ZodError) {
    const firstIssue = cause.issues[0];
    const detail = firstIssue
      ? `${firstIssue.path.map(String).join(".") || "(root)"}: ${firstIssue.message}`
      : cause.message;
    super(`Invalid agent configuration: ${detail}`);
    this.name = "ConfigValidationError";
    this.issues = cause.issues;
    this.cause = cause;
  }
}

// ─── Validation helper ──────────────────────────────────────────────────────

/**
 * Validate a raw config object against {@link AgentConfigSchema}.
 *
 * @param input The raw config (typically a partial user override merged on
 *              top of {@link DEFAULT_CONFIG}).
 * @returns The validated config with defaults filled in.
 * @throws {ConfigValidationError} when validation fails.
 */
export function validateConfig(input: unknown): AgentConfigValidated {
  const result = AgentConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(result.error);
  }
  return result.data;
}
