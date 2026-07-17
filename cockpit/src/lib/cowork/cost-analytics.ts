// Framework-free cost & usage analytics helpers.
//
// Pure, deterministic logic extracted from the `cost-view` React component so it
// can be unit-tested without loading the UI stack (framer-motion, etc.). No
// rendering, no DOM, no React — just data in, data out.

export interface CostUsageRecord {
  id: string;
  timestamp: number;
  agent: string;
  model: string;
  domain: string;
  taskTitle: string;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCached: number;
  costUsd: number;
}

export interface CostAnalytics {
  rangeDays: number;
  startMs: number;
  endMs: number;
  totalCost: number;
  totalTokens: number;
  tokensIn: number;
  tokensOut: number;
  avgCostPerDay: number;
  daily: { date: string; ms: number; cost: number; tokens: number }[];
  byAgent: CostBreakdownRow[];
  byModel: CostBreakdownRow[];
  byDomain: CostBreakdownRow[];
  topRuns: CostUsageRecord[];
  projectedMonthCost: number;
  isEstimate: boolean;
}

export interface CostBreakdownRow {
  key: string;
  label: string;
  cost: number;
  tokens: number;
  runs: number;
  share: number;
}

export type RangeKey = "7d" | "30d" | "90d" | "custom";
export type BreakdownDim = "agent" | "model" | "domain";

const DAY_MS = 86_400_000;

export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function computeRange(
  range: RangeKey,
  customStart: string,
  customEnd: string,
): { startMs: number; endMs: number; rangeDays: number; rangeError: string | null } {
  const now = Date.now();
  if (range === "custom") {
    const sRaw = customStart ? new Date(customStart).getTime() : now - 7 * DAY_MS;
    const eRaw = customEnd ? new Date(customEnd).getTime() : now;
    if (
      (customStart !== "" && Number.isNaN(sRaw)) ||
      (customEnd !== "" && Number.isNaN(eRaw))
    ) {
      return {
        startMs: Number.isFinite(sRaw) ? sRaw : now - 7 * DAY_MS,
        endMs: Number.isFinite(eRaw) ? eRaw : now,
        rangeDays: 1,
        rangeError: "Enter valid start and end dates.",
      };
    }
    if (sRaw > eRaw) {
      return {
        startMs: Number.isFinite(sRaw) ? sRaw : now - 7 * DAY_MS,
        endMs: Number.isFinite(eRaw) ? eRaw : now,
        rangeDays: 1,
        rangeError: "Start date must be on or before the end date.",
      };
    }
    const days = Math.max(1, Math.round((eRaw - sRaw) / DAY_MS) || 1);
    return { startMs: sRaw, endMs: eRaw, rangeDays: days, rangeError: null };
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return {
    startMs: now - (days - 1) * DAY_MS,
    endMs: now,
    rangeDays: days,
    rangeError: null,
  };
}

export function recordTokens(r: CostUsageRecord): number {
  return r.tokensIn + r.tokensOut + r.tokensReasoning + r.tokensCached;
}

function buildBreakdown(
  records: CostUsageRecord[],
  keyFn: (r: CostUsageRecord) => string,
  totalCost: number,
): CostBreakdownRow[] {
  const m = new Map<string, { cost: number; tokens: number; runs: number }>();
  for (const r of records) {
    const k = keyFn(r);
    const e = m.get(k) ?? { cost: 0, tokens: 0, runs: 0 };
    e.cost += r.costUsd;
    e.tokens += recordTokens(r);
    e.runs += 1;
    m.set(k, e);
  }
  return Array.from(m.entries())
    .map(([k, v]) => ({
      key: k,
      label: k,
      cost: v.cost,
      tokens: v.tokens,
      runs: v.runs,
      share: totalCost > 0 ? v.cost / totalCost : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function deriveCostAnalytics(
  records: CostUsageRecord[],
  rangeDays: number,
  startMs: number,
  endMs: number,
  isEstimate: boolean,
): CostAnalytics {
  const days: { date: string; ms: number; cost: number; tokens: number }[] = [];
  const byDay = new Map<number, { cost: number; tokens: number }>();
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  const endDay = new Date(endMs);
  endDay.setHours(23, 59, 59, 999);
  let cur = cursor.getTime();
  while (cur <= endDay.getTime()) {
    days.push({ date: isoDay(new Date(cur)), ms: cur, cost: 0, tokens: 0 });
    byDay.set(cur, { cost: 0, tokens: 0 });
    cur += DAY_MS;
  }

  let totalCost = 0;
  let totalTokens = 0;
  let tIn = 0;
  let tOut = 0;
  for (const r of records) {
    const d = new Date(r.timestamp);
    d.setHours(0, 0, 0, 0);
    const bucket = byDay.get(d.getTime());
    const tok = recordTokens(r);
    if (bucket) {
      bucket.cost += r.costUsd;
      bucket.tokens += tok;
    }
    totalCost += r.costUsd;
    totalTokens += tok;
    tIn += r.tokensIn;
    tOut += r.tokensOut;
  }
  days.forEach((d) => {
    const b = byDay.get(d.ms);
    if (b) {
      d.cost = b.cost;
      d.tokens = b.tokens;
    }
  });

  const byAgent = buildBreakdown(records, (r) => r.agent, totalCost);
  const byModel = buildBreakdown(records, (r) => r.model, totalCost);
  const byDomain = buildBreakdown(records, (r) => r.domain || "—", totalCost);
  const topRuns = records
    .slice()
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8);
  const avgCostPerDay = rangeDays > 0 ? totalCost / rangeDays : 0;

  return {
    rangeDays,
    startMs,
    endMs,
    totalCost,
    totalTokens,
    tokensIn: tIn,
    tokensOut: tOut,
    avgCostPerDay,
    daily: days,
    byAgent,
    byModel,
    byDomain,
    topRuns,
    projectedMonthCost: avgCostPerDay * 30,
    isEstimate,
  };
}

export function formatUsd(n: number): string {
  if (!isFinite(n)) return "$0.00";
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function csvField(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export function analyticsToCsv(a: CostAnalytics): string {
  const lines: string[] = [];
  lines.push("Open Cowork — Cost & Usage Export");
  if (a.isEstimate) {
    lines.push(
      "NOTE: estimated values — backend cost persistence is not yet available, so figures are derived approximations.",
    );
  }
  lines.push(`range_days,${csvField(a.rangeDays)}`);
  lines.push(`start,${csvField(new Date(a.startMs).toISOString())}`);
  lines.push(`end,${csvField(new Date(a.endMs).toISOString())}`);
  lines.push(`total_cost_usd,${csvField(a.totalCost.toFixed(6))}`);
  lines.push(`total_tokens,${csvField(a.totalTokens)}`);
  lines.push(`projected_month_cost_usd,${csvField(a.projectedMonthCost.toFixed(6))}`);
  lines.push("");
  lines.push("daily");
  lines.push("date,cost_usd,tokens");
  a.daily.forEach((d) =>
    lines.push(
      [csvField(d.date), csvField(d.cost.toFixed(6)), csvField(d.tokens)].join(","),
    ),
  );
  lines.push("");
  const dumpDim = (name: string, rows: CostBreakdownRow[]) => {
    lines.push(name);
    lines.push("key,cost_usd,tokens,runs,share");
    rows.forEach((r) =>
      lines.push(
        [
          csvField(r.key),
          csvField(r.cost.toFixed(6)),
          csvField(r.tokens),
          csvField(r.runs),
          csvField(r.share.toFixed(4)),
        ].join(","),
      ),
    );
    lines.push("");
  };
  dumpDim("by_agent", a.byAgent);
  dumpDim("by_model", a.byModel);
  dumpDim("by_domain", a.byDomain);
  lines.push("top_runs");
  lines.push("id,timestamp,agent,model,domain,task_title,tokens_in,tokens_out,cost_usd");
  a.topRuns.forEach((r) =>
    lines.push(
      [
        csvField(r.id),
        csvField(new Date(r.timestamp).toISOString()),
        csvField(r.agent),
        csvField(r.model),
        csvField(r.domain),
        csvField(r.taskTitle),
        csvField(r.tokensIn),
        csvField(r.tokensOut),
        csvField(r.costUsd.toFixed(6)),
      ].join(","),
    ),
  );
  return lines.join("\n");
}
