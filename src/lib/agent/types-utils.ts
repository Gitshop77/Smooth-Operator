import type { AgentConfig } from "./types";

export const DEFAULT_COST_CAP = 2;
export const DEFAULT_CONFIG: AgentConfig = {
  costCapUsd: DEFAULT_COST_CAP,
  maxSteps: 100,
  maxActionsPerStep: 10,
  plannerInterval: 5,
  maxFailures: 5,
  enableLoopDetection: true,
  enableCompaction: true,
  compactionStepInterval: 20,
  compactionCharThreshold: 30_000,
  llmCallTimeoutMs: 180_000,
  enableJudge: true,
  enableEarlyStop: true,
  enableHtmlSummarizer: true,
};
