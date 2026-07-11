/**
 * Centralized configuration validation using Zod.
 *
 * Provides a Zod schema for {@link AgentConfig} + a {@link validateConfig}
 * helper that produces a validated config (or throws a typed
 * {@link ConfigValidationError}).
 *
 * The schema mirrors the existing {@link AgentConfig} interface in
 * `../types.ts`. The validated output is compatible with what
 * `{ ...DEFAULT_CONFIG, ...userConfig }` produced before — the schema just
 * adds runtime validation at the boundary. (Compatible, but not strictly
 * structurally identical: a few fields such as `enableJudge` differ in
 * optionality between the input and output types.)
 *
 * Usage:
 *   import { validateConfig, type AgentConfigInput } from "@/lib/agent/config/schema";
 *   function createAgent(userConfig: Partial<AgentConfigInput>) {
 *     const merged = { ...DEFAULT_CONFIG, ...userConfig };
 *     const config = validateConfig(merged);
 *     // config is a fully-validated AgentConfig
 *   }
 *
 * The orchestrator calls {@link validateConfig} on every run. The input is
 * always a merge of {@link DEFAULT_CONFIG} over any user override
 * (`{ ...DEFAULT_CONFIG, ...userConfig }`), so every field has a value. If
 * validation fails, {@link validateConfig} throws a {@link ConfigValidationError}
 * and the orchestrator re-throws it as a hard failure — a broken config is
 * NEVER silently accepted.
 */

import { z } from "zod";

// ─── Sub-schemas ────────────────────────────────────────────────────────────

/** Schema for a single string-match evaluator input. */
const StringMatchSchema = z
  .object({
    type: z.enum(["exact_match", "must_include", "regex"]),
    // Bound the pattern length so an attacker-influenced config cannot supply
    // an arbitrarily huge (and potentially catastrophic-backtracking) regex.
    ref: z.string().max(2000),
  })
  .superRefine((val, ctx) => {
    // Validate `regex`-type refs compile at the boundary (don't push the check
    // to evaluator runtime). This also bounds ReDoS risk: an invalid pattern is
    // rejected here rather than silently treated as "no match" later, and a
    // compiling-but-pathological pattern is at least length-capped above.
    if (val.type === "regex") {
      try {
        new RegExp(val.ref);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "regex ref is not a valid regular expression",
          path: ["ref"],
        });
      }
    }
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
  /**
   * Whether to run the judge LLM after the planner reports task success.
   * Optional here (mirrors {@link AgentConfig}) — the orchestrator always merges
   * {@link DEFAULT_CONFIG}, which sets it to `true`, so the runtime value is
   * always present. Kept optional (not `.default(true)`) so the validated
   * output type stays structurally identical to {@link AgentConfig}.
   */
  enableJudge: z.boolean().optional(),
  /** Whether to enable early-stop detection. */
  enableEarlyStop: z.boolean().optional(),
  /** Optional thresholds for the early-stop detector. */
  earlyStopThresholds: EarlyStopThresholdsSchema.optional(),
  /**
   * Whether to run the HTML-summarizer pre-pass before each navigator call.
   * Defaults to `true`: the summarizer is the single biggest per-action cost
   * lever (the raw DOM is the largest part of the navigator request), so it is
   * ON by default. Operators can opt OUT, but the navigator always applies a
   * hard cap on the DOM size it ships to the model regardless of this flag (see
   * `buildNavigatorUserMessage` / `prepareNavigatorRequest`).
   */
  enableHtmlSummarizer: z.boolean().optional().default(true),
  /** Optional expected-outcomes spec for deterministic evaluator fast-path. */
  expectedOutcomes: ExpectedOutcomesSchema.optional(),
});

/** Input type for {@link AgentConfigSchema} (accepts partial input). */
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;

/** Validated output type — compatible with, but not strictly identical to, {@link AgentConfig}. */
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
