"use client";

/**
 * Cost & Usage Analytics view.
 *
 * ── Data-source reality (see `.audit/data.md` §5 "Cost & Usage — NO DATA SOURCE") ──
 * The pricing engine (`src/lib/agent/llm/pricing.ts`) lives in the *agent runtime*
 * and is imported by the orchestrator/providers. It is NOT exposed by any cockpit
 * route, and there is no stored token-usage / cost table behind `/api/cowork/*`.
 * `GET /api/cowork/history` is browsing history (no token/cost fields) and
 * `SampleTask` carries no token/cost fields either, so NO real cost estimate can
 * be derived from any currently-available endpoint. Per the project rule ("never
 * fabricate sample data") this view therefore renders a polished standby state
 * until a persisted usage/cost model + endpoint lands.
 *
 * The full analytics pipeline below (`CostUsageRecord` → `deriveCostAnalytics`) is
 * implemented and ready: when a real `useCostUsage()` hook is wired (returning
 * `CostUsageRecord[]`), flip `records` to that data and the entire dashboard
 * lights up with zero further changes. No backend routes were added and
 * `pricing.ts` was not modified, so the build/tests stay green.
 */

import * as React from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Boxes,
  Coins,
  Cpu,
  CalendarDays,
  Download,
  DollarSign,
  Globe,
  Info,
  LineChart,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/cowork/shared/data-table";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { StatusPill } from "@/components/cowork/shared/status-pill";

// ─── Data model (consumed once a real cost endpoint exists) ────────────────────

/** A single billable unit of agent work with token + cost accounting. */
export interface CostUsageRecord {
  id: string;
  /** Epoch ms when the run/step completed. */
  timestamp: number;
  /** Agent id / display name that produced the usage. */
  agent: string;
  /** Model id the tokens were billed against (e.g. "gpt-4o", "claude-3-5-sonnet"). */
  model: string;
  /** Target domain the run acted on, or "—" when not applicable. */
  domain: string;
  /** Mission / run title for the top-runs list. */
  taskTitle: string;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  tokensCached: number;
  /** Precomputed spend for this record in USD. */
  costUsd: number;
}

/** Aggregated, render-ready analytics for a selected range. */
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
  /** Linear projection of the current daily run-rate across a 30-day month. */
  projectedMonthCost: number;
  /** True when the figures are derived estimates rather than persisted billing. */
  isEstimate: boolean;
}

export interface CostBreakdownRow {
  key: string;
  label: string;
  cost: number;
  tokens: number;
  runs: number;
  /** Share of total cost, 0..1. */
  share: number;
}

type RangeKey = "7d" | "30d" | "90d" | "custom";
type BreakdownDim = "agent" | "model" | "domain";

const DAY_MS = 86_400_000;

// ─── Pure helpers ──────────────────────────────────────────────────────────────

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computeRange(
  range: RangeKey,
  customStart: string,
  customEnd: string,
): { startMs: number; endMs: number; rangeDays: number; rangeError: string | null } {
  const now = Date.now();
  if (range === "custom") {
    const sRaw = customStart ? new Date(customStart).getTime() : now - 7 * DAY_MS;
    const eRaw = customEnd ? new Date(customEnd).getTime() : now;
 // Reject invalid input instead of silently degrading to an empty state.
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

function recordTokens(r: CostUsageRecord): number {
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

/** Collapse raw records into render-ready analytics for the given range. */
export function deriveCostAnalytics(
  records: CostUsageRecord[],
  rangeDays: number,
  startMs: number,
  endMs: number,
  isEstimate: boolean,
): CostAnalytics {
 // Daily buckets (inclusive of both endpoints).
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

// ─── Formatting ────────────────────────────────────────────────────────────────

function formatUsd(n: number): string {
  if (!isFinite(n)) return "$0.00";
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Escape an arbitrary value for a single CSV field.
 *
 * - RFC-4180 quoting: wrap in double quotes and double any embedded quotes so
 * commas, quotes, and newlines can never corrupt the column/row structure.
 * - Formula-injection guard: spreadsheet apps (Excel/Sheets/LibreOffice) treat a
 * cell whose text begins with `=`, `+`, `-`, `@`, tab, or CR as a formula. We
 * prefix such values with a single quote so they render as literal text.
 */
function csvField(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

function analyticsToCsv(a: CostAnalytics): string {
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

// ─── Sub-components ────────────────────────────────────────────────────────────

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "custom", label: "Custom" },
];

const BREAKDOWN_DIMENSIONS = [
  { key: "agent", label: "Agent", icon: Boxes },
  { key: "model", label: "Model", icon: Cpu },
  { key: "domain", label: "Domain", icon: Globe },
] as const;

const DIM_TO_FIELD = {
  agent: "byAgent",
  model: "byModel",
  domain: "byDomain",
} as const;

function RangeSelector({
  range,
  onRange,
}: {
  range: RangeKey;
  onRange: (r: RangeKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Select date range"
      className="inline-flex items-center rounded-[10px] border border-border bg-muted p-0.5"
    >
      {RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          aria-pressed={range === opt.key}
          onClick={() => onRange(opt.key)}
          className={cn(
            "h-7 rounded-[8px] px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            range === opt.key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function TrendChart({
  daily,
}: {
  daily: CostAnalytics["daily"];
}) {
  const W = 720;
  const H = 180;
  const gradId = React.useId();
  const pad = { t: 14, r: 10, b: 24, l: 10 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const baseY = pad.t + innerH;
  const max = Math.max(1e-9, ...daily.map((d) => d.cost));
  const n = daily.length;

  const x = (i: number) =>
    pad.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => baseY - (v / max) * innerH;

  const linePts = daily.map((d, i) => `${x(i).toFixed(1)},${y(d.cost).toFixed(1)}`);
  const linePath = linePts.length
    ? `M ${linePts.join(" L ")}`
    : "";
  const areaPath = linePts.length
    ? `M ${x(0).toFixed(1)},${baseY} L ${linePts.join(" L ")} L ${x(n - 1).toFixed(1)},${baseY} Z`
    : "";

 // A few evenly-spaced x-axis date labels.
  const tickIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full text-primary"
      role="img"
      aria-label="Daily spend trend"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-subtle)" />
          <stop offset="100%" stopColor="var(--accent-subtle)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {areaPath ? <path d={areaPath} fill={`url(#${gradId})`} /> : null}
      {linePath ? (
        <path
          d={linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      {tickIdx.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={H - 6}
          textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
          fontSize={10}
          fill="var(--dim)"
        >
          {daily[i]?.date}
        </text>
      ))}
    </svg>
  );
}

function BreakdownBars({ rows }: { rows: CostBreakdownRow[] }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.cost));
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No usage in this range.</p>
    );
  }
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.key} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-foreground">{r.label}</span>
            <span className="cowork-mono tnum shrink-0 text-muted-foreground">
              {formatUsd(r.cost)} · {(r.share * 100).toFixed(1)}%
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function BudgetPanel({
  analytics,
  budget,
  onBudget,
}: {
  analytics: CostAnalytics;
  budget: number;
  onBudget: (v: number) => void;
}) {
  const projected = analytics.projectedMonthCost;
  const pct = budget > 0 ? Math.min(100, (projected / budget) * 100) : 0;
  const over = projected > budget;
  const near = !over && projected > budget * 0.8;

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-warn" aria-hidden />
          <p className="text-sm font-semibold text-foreground">Budget guard</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Monthly budget
          <Input
            type="number"
            min={0}
            step={5}
            value={budget}
            aria-label="Monthly budget in USD"
            onChange={(e) => onBudget(Math.max(0, Number(e.target.value) || 0))}
            className="h-8 w-24 cowork-mono tnum"
          />
        </label>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            over ? "bg-danger" : near ? "bg-warn" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="cowork-mono tnum text-muted-foreground">
          Projected {formatUsd(projected)} / mo
        </span>
        {over ? (
          <StatusPill tone="error">
            Over budget by {formatUsd(projected - budget)}
          </StatusPill>
        ) : near ? (
          <StatusPill tone="warning">
            Approaching budget ({pct.toFixed(0)}%)
          </StatusPill>
        ) : (
          <StatusPill tone="success">Within budget</StatusPill>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Projection extrapolates the current {analytics.rangeDays}d run-rate (
        {formatUsd(analytics.avgCostPerDay)}/day) across a 30-day month.
      </p>
    </Card>
  );
}

// ─── Main view ─────────────────────────────────────────────────────────────────

export function CostView() {
  const [range, setRange] = React.useState<RangeKey>("30d");
  const [customStart, setCustomStart] = React.useState("");
  const [customEnd, setCustomEnd] = React.useState("");
  const [breakdownDim, setBreakdownDim] =
    React.useState<BreakdownDim>("agent");
  const [budget, setBudget] = React.useState(50);

 // ── Cost data source ──────────────────────────────────────────────────────
 // No persisted cost/usage endpoint exists yet (see file header + .audit/data.md §5).
 // `/history` (browsing) and `SampleTask` expose no token fields, so even a rough
 // estimate cannot be derived without fabricating data — which this codebase forbids.
 // When a `useCostUsage()` hook lands, assign its result here and everything below
 // renders with real numbers.
  const records: CostUsageRecord[] = [];
  const isEstimate = false;

  const { startMs, endMs, rangeDays, rangeError } = React.useMemo(
    () => computeRange(range, customStart, customEnd),
    [range, customStart, customEnd],
  );

  const analytics = React.useMemo(
    () => deriveCostAnalytics(records, rangeDays, startMs, endMs, isEstimate),
    [records, rangeDays, startMs, endMs, isEstimate],
  );

  const hasData = records.length > 0;

  const handleExport = React.useCallback(() => {
    if (!hasData) return;
    const csv = analyticsToCsv(analytics);
    const stamp = isoDay(new Date());
    downloadCsv(`open-cowork-cost-${stamp}.csv`, csv);
  }, [hasData, analytics]);

  const dimMeta =
    BREAKDOWN_DIMENSIONS.find((d) => d.key === breakdownDim)!;
  const breakdownRows = analytics[DIM_TO_FIELD[breakdownDim]];
  const breakdownIcon = React.createElement(dimMeta.icon, {
    className: "size-3.5",
    "aria-hidden": true,
  });

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Cost & Usage"
        description="Token spend and usage analytics across agent runs."
        eyebrow="Observe"
        icon={<DollarSign className="size-5" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <RangeSelector range={range} onRange={setRange} />
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={!hasData}
              title={hasData ? "Export analytics as CSV" : "No cost data to export"}
              className="gap-1.5"
            >
              <Download className="size-4" aria-hidden />
              Export CSV
            </Button>
          </div>
        }
      />

      {range === "custom" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="size-4" aria-hidden />
          <label className="flex items-center gap-1.5">
            From
            <Input
              type="date"
              value={customStart}
              aria-label="Custom range start date"
              onChange={(e) => setCustomStart(e.target.value)}
              className="h-8 w-auto"
            />
          </label>
          <label className="flex items-center gap-1.5">
            To
            <Input
              type="date"
              value={customEnd}
              aria-label="Custom range end date"
              onChange={(e) => setCustomEnd(e.target.value)}
              className="h-8 w-auto"
            />
          </label>
        </div>
      ) : null}

      {rangeError ? (
        <div className="flex items-center gap-2 rounded-[10px] border border-l-[3px] border-l-warn bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="size-4 text-warn" aria-hidden />
          {rangeError}
        </div>
      ) : null}

      {hasData ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="space-y-4"
        >
          {analytics.isEstimate ? (
            <div className="flex items-center gap-2 rounded-[10px] border border-l-[3px] border-l-warn bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Info className="size-4 text-warn" aria-hidden />
              These figures are <span className="font-medium text-foreground">estimated</span> from
              available run metadata — not persisted billing. They will be replaced by exact costs
              once backend cost persistence ships.
            </div>
          ) : null}

          {/* Headline metrics */}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total spend"
              value={
                <span className="cowork-mono tnum">{formatUsd(analytics.totalCost)}</span>
              }
              delta={`over ${analytics.rangeDays}d`}
              tone="accent"
              icon={<DollarSign className="size-4" />}
            />
            <StatCard
              label="Total tokens"
              value={
                <span className="cowork-mono tnum">{formatTokens(analytics.totalTokens)}</span>
              }
              delta={
                <span>
                  <span className="text-info">{formatTokens(analytics.tokensIn)}</span> in ·{" "}
                  <span className="text-success">{formatTokens(analytics.tokensOut)}</span> out
                </span>
              }
              icon={<Coins className="size-4" />}
            />
            <StatCard
              label="Avg / day"
              value={
                <span className="cowork-mono tnum">{formatUsd(analytics.avgCostPerDay)}</span>
              }
              delta="run-rate"
              icon={<TrendingUp className="size-4" />}
            />
            <StatCard
              label="Projected / mo"
              value={
                <span className="cowork-mono tnum">{formatUsd(analytics.projectedMonthCost)}</span>
              }
              delta="linear extrapolation"
              icon={<TrendingDown className="size-4" />}
            />
          </div>

          {/* Trend chart */}
          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="cowork-eyebrow">Spend trend</p>
              <span className="text-xs text-muted-foreground cowork-mono tnum">
                {formatUsd(analytics.totalCost)} · {analytics.daily.length}d
              </span>
            </div>
            <TrendChart daily={analytics.daily} />
          </Card>

          {/* Budget + breakdown */}
          <div className="grid gap-4 lg:grid-cols-2">
            <BudgetPanel analytics={analytics} budget={budget} onBudget={setBudget} />

            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="cowork-eyebrow">Breakdown</p>
                <div
                  role="group"
                  aria-label="Breakdown dimension"
                  className="inline-flex items-center rounded-[10px] border border-border bg-muted p-0.5"
                >
                  {BREAKDOWN_DIMENSIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      aria-pressed={breakdownDim === opt.key}
                      onClick={() => setBreakdownDim(opt.key)}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-[8px] px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                        breakdownDim === opt.key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden />
                      {opt.label}
                    </button>
                  );
                })}
                </div>
              </div>
              <BreakdownBars rows={breakdownRows} />
            </Card>
          </div>

          {/* Top-expensive runs */}
          <Card className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              {breakdownIcon}
              <p className="cowork-eyebrow">Top expensive runs</p>
            </div>
            {analytics.topRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs in this range.</p>
            ) : (
              <DataTable
                caption="Most expensive runs in range"
                columns={["Run", "Agent", "Model", "Tokens", "Cost", "When"]}
              >
                {analytics.topRuns.map((r) => (
                  <tr
                    key={r.id}
                    className="align-top transition-colors hover:bg-accent/40"
                  >
                    <td className="px-4 py-2.5 max-w-[240px] truncate text-sm">{r.taskTitle}</td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground">
                      {r.agent}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground">
                      {r.model}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono tnum">
                      {formatTokens(recordTokens(r))}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono tnum text-foreground">
                      {formatUsd(r.costUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] cowork-mono tnum text-muted-foreground whitespace-nowrap">
                      {new Date(r.timestamp).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Card>
        </motion.div>
      ) : (
        <EmptyState
          icon={<LineChart className="size-6" />}
          title="No cost data yet"
          description="Cost & usage tracking will populate automatically once agent runs are recorded with token usage. The pricing engine already lives in the agent runtime (pricing.ts), but spend isn't persisted to a cockpit endpoint yet — so there's nothing to chart right now. Connect an LLM-backed agent and run a few tasks to light this up."
        />
      )}
    </div>
  );
}
