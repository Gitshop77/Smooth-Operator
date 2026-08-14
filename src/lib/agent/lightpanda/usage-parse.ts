/**
 * Parse Lightpanda's `$usage` cost line from `agent --task` stderr.
 *
 * Format pinned by Agent.zig:556-568 (printUsageSummary, printed only on the
 * one-shot --task path, printed whether the turn succeeded or failed):
 *   $usage prompt=N completion=N total=N cached=N cache_creation=N
 */
export interface ResearchUsage {
  tokensIn: number;
  tokensOut: number;
  cached: number;
  cacheCreation: number;
}

const USAGE_RE = /\$usage prompt=(\d+) completion=(\d+) total=(\d+) cached=(\d+) cache_creation=(\d+)/;

export function parseUsageLine(line: string): ResearchUsage | null {
  const m = USAGE_RE.exec(line);
  if (!m) return null;
  return {
    tokensIn: Number(m[1]) || 0,
    tokensOut: Number(m[2]) || 0,
    cached: Number(m[4]) || 0,
    cacheCreation: Number(m[5]) || 0,
  };
}

/** Scan stderr for the first `$usage` line. */
export function parseUsage(stderr: string): ResearchUsage | null {
  for (const line of stderr.split("\n")) {
    const usage = parseUsageLine(line);
    if (usage) return usage;
  }
  return null;
}

/**
 * One-shot `agent --task` prints the buffered final answer on stdout as plain
 * text plus a trailing newline (Terminal.printAssistant writes text + "\n").
 */
export function extractAnswer(stdout: string): string {
  return stdout.trim();
}