/**
 * Regression tests for the compaction secret-redaction pipeline.
 *
 * `renderHistoryForSummarization` and `sanitizeCompactedMemory` must strip
 * high-confidence secret shapes from page-derived content before it leaves the
 * user's machine (toward the summarizer LLM and back into the navigator's
 * `<compacted_memory>`). These tests lock the key-shape coverage so a future
 * narrowing or drift of the local redactor is caught.
 */

import { describe, test, expect } from "vitest";
import {
  renderHistoryForSummarization,
  sanitizeCompactedMemory,
} from "../src/lib/agent/loop/compaction";
import type { HistoryItem } from "../src/lib/agent/types";

const GROK = "gsk-" + "a".repeat(20);
const GITHUB = "ghp_" + "b".repeat(36);
const GITLAB = "glpat-" + "c".repeat(20);
const DB_URL = "postgres://user:pass@db.example.com:5432/app";

/** Patterns that must never survive the compaction redaction pipeline. */
const MUST_REDACT = [GROK, GITHUB, GITLAB, DB_URL];

function secretItem(secret: string): HistoryItem {
  return {
    step: 0,
    agent: "navigator",
    evaluation: `evaluation holds ${secret}`,
    memory: "memory note",
    goal: `goal references ${secret}`,
    results: [
      {
        // `action` is structurally irrelevant to redaction here; a minimal
        // shape satisfies the type without pulling in the full action union.
        action: { type: "extract" } as HistoryItem["results"][number]["action"],
        success: true,
        message: `result carries ${secret}`,
        extractedContent: `extracted value ${secret}`,
      },
    ],
  };
}

describe("renderHistoryForSummarization redaction coverage", () => {
  for (const secret of MUST_REDACT) {
    test(`redacts ${secret.slice(0, 10)}… from rendered history`, () => {
      const out = renderHistoryForSummarization([secretItem(secret)]);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    });
  }
});

describe("sanitizeCompactedMemory redaction coverage", () => {
  for (const secret of MUST_REDACT) {
    test(`redacts ${secret.slice(0, 10)}… from compacted memory`, () => {
      const summary = `Prior steps summary: we saw ${secret} in the page.`;
      const out = sanitizeCompactedMemory(summary);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    });
  }
});
