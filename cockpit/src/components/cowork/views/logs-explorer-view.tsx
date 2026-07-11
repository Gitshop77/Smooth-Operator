"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ScrollText,
  Download,
  TerminalSquare,
  AlertTriangle,
  Info,
  Bug,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { SearchInput } from "@/components/cowork/shared/search-input";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { ExtensionOnly } from "@/components/cowork/shared/extension-only";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Logs Explorer — the debug/analysis log feed for the cockpit.
 *
 * ⚠️ UI-COMPLETE, BACKEND-PENDING.
 * There is currently NO GET endpoint for logs. The only log surface is
 * `POST /api/cowork/extensions/log`, which writes a single structured line to
 * the server `console.error('[SW]', …)` and never persists anything (see
 * `.audit/data.md` §3). This view is fully built against a `CoworkLogEntry`
 * contract and renders a polished, on-brand standby state until a backend
 * ring-buffer + `GET` feed exists. When that lands, wire a `useLogs()` hook
 * (mirroring the other `createQueryHook` list hooks) and feed `logs` below —
 * no other changes required. We never fabricate sample log rows.
 */

// ─── Contract (mirrors the eventual GET /api/cowork/extensions/log shape) ───

type LogLevel = "debug" | "info" | "warn" | "error";
type LogSource = "planner" | "navigator" | "tool" | "observer";
/** Side-panel terminal log semantics (Signal Indigo `--log-*` tokens). */
type LogKind =
  | "step"
  | "observe"
  | "reason"
  | "act"
  | "ok"
  | "err"
  | "info"
  | "cost";

interface CoworkLogEntry {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  level: LogLevel;
  /** Semantic category — drives the colored marker. */
  kind: LogKind;
  source: LogSource;
  /** Originating agent id/name. */
  agent: string;
  message: string;
  /** Optional structured detail (stack trace, payload, etc.). */
  meta?: string;
}

// ─── Token-driven color maps (NO hardcoded hex) ─────────────────────────────

/** The 8 Signal Indigo `--log-*` semantic tokens, surfaced as Tailwind utilities. */
const LOG_KIND_META: Record<LogKind, { label: string; badge: string; dot: string }> = {
  step: { label: "step", badge: "bg-log-step/10 text-log-step border-log-step/30", dot: "bg-log-step" },
  observe: { label: "observe", badge: "bg-log-observe/10 text-log-observe border-log-observe/30", dot: "bg-log-observe" },
  reason: { label: "reason", badge: "bg-log-reason/10 text-log-reason border-log-reason/30", dot: "bg-log-reason" },
  act: { label: "act", badge: "bg-log-act/10 text-log-act border-log-act/30", dot: "bg-log-act" },
  ok: { label: "ok", badge: "bg-log-ok/10 text-log-ok border-log-ok/30", dot: "bg-log-ok" },
  err: { label: "err", badge: "bg-log-err/10 text-log-err border-log-err/30", dot: "bg-log-err" },
  info: { label: "info", badge: "bg-log-info/10 text-log-info border-log-info/30", dot: "bg-log-info" },
  cost: { label: "cost", badge: "bg-log-cost/10 text-log-cost border-log-cost/30", dot: "bg-log-cost" },
};

/** Level → StatusPill tone + per-level chip styling (token utilities only). */
const LEVEL_META: Record<LogLevel, { label: string; tone: "info" | "warning" | "error"; chip: string }> = {
  debug: { label: "debug", tone: "info", chip: "text-log-info border-log-info" },
  info: { label: "info", tone: "info", chip: "text-info border-info" },
  warn: { label: "warn", tone: "warning", chip: "text-warn border-warn" },
  error: { label: "error", tone: "error", chip: "text-destructive border-destructive" },
};

const ALL_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const ALL_SOURCES: LogSource[] = ["planner", "navigator", "tool", "observer"];
const ALL_KINDS: LogKind[] = ["step", "observe", "reason", "act", "ok", "err", "info", "cost"];

const TIME_RANGES: { label: string; ms: number | null }[] = [
  { label: "All time", ms: null },
  { label: "Last 15 min", ms: 15 * 60_000 },
  { label: "Last 1 hour", ms: 60 * 60_000 },
  { label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
];

/**
 * Cap the number of log rows mounted into the DOM at once. A single run can
 * emit thousands of events; rendering every match as a live node degrades
 * scroll/memory. We render a page and reveal more on demand (dependency-free,
 * no virtualization lib required).
 */
const LOG_PAGE_SIZE = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTs(ts)}`;
}

// ─── Filter controls ─────────────────────────────────────────────────────────

interface LevelFilterProps {
  active: Set<LogLevel>;
  onToggle: (level: LogLevel) => void;
}

function LevelFilterChips({ active, onToggle }: LevelFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by log level">
      {ALL_LEVELS.map((lvl) => {
        const isOn = active.has(lvl);
        const meta = LEVEL_META[lvl];
        return (
          <button
            key={lvl}
            type="button"
            aria-pressed={isOn}
            onClick={() => onToggle(lvl)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              isOn
                ? meta.chip + " bg-foreground/[0.03]"
                : "border-border text-muted-foreground hover:border-border-hover hover:text-foreground",
            )}
          >
            {lvl === "debug" ? (
              <Bug className="size-3" aria-hidden />
            ) : lvl === "info" ? (
              <Info className="size-3" aria-hidden />
            ) : lvl === "warn" ? (
              <AlertTriangle className="size-3" aria-hidden />
            ) : (
              <AlertTriangle className="size-3" aria-hidden />
            )}
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Log row ──────────────────────────────────────────────────────────────────

interface LogRowProps {
  entry: CoworkLogEntry;
}

function LogRow({ entry }: LogRowProps) {
  const [open, setOpen] = React.useState(false);
  const kind = LOG_KIND_META[entry.kind];
  const level = LEVEL_META[entry.level];

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-raised/50 transition-colors"
      >
        <span className={cn("mt-1 size-2 shrink-0 rounded-full", kind.dot)} aria-hidden />
        <span className="mt-0.5 shrink-0 cowork-mono text-[11px] text-dim tabular-nums" title={formatDate(entry.ts)}>
          {formatTs(entry.ts)}
        </span>
        <span className="mt-0.5 shrink-0">
          <StatusPill tone={level.tone} className="capitalize">{level.label}</StatusPill>
        </span>
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-[6px] border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            kind.badge,
          )}
        >
          {kind.label}
        </span>
        <span className="mt-0.5 shrink-0 rounded-[6px] border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {entry.source}
        </span>
        <span className="mt-0.5 shrink-0 cowork-mono text-[11px] text-muted-foreground">{entry.agent}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{entry.message}</span>
      </button>
      {open && entry.meta ? (
        <pre className="cowork-mono mx-3 mb-2 overflow-x-auto rounded-lg border border-border bg-bg/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {entry.meta}
        </pre>
      ) : null}
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function LogsExplorerView() {
  // Backend feed is not wired yet — this stays empty until a GET endpoint exists.
  // A `useLogs()` hook (like the other createQueryHook list hooks) would populate it.
  const logs: CoworkLogEntry[] = [];

  const [query, setQuery] = React.useState("");
  const [levels, setLevels] = React.useState<Set<LogLevel>>(new Set(ALL_LEVELS));
  const [source, setSource] = React.useState<LogSource | "all">("all");
  const [agent, setAgent] = React.useState<string>("all");
  const [rangeIdx, setRangeIdx] = React.useState(0);
  const [tail, setTail] = React.useState(false);
  const [visibleCount, setVisibleCount] = React.useState(LOG_PAGE_SIZE);

  const tailRef = React.useRef<HTMLDivElement>(null);

  const toggleLevel = React.useCallback((lvl: LogLevel) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  }, []);

  const agents = React.useMemo(
    () => Array.from(new Set(logs.map((l) => l.agent))).sort(),
    [logs],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const range = TIME_RANGES[rangeIdx].ms;
    const now = Date.now();
    return logs.filter((l) => {
      if (!levels.has(l.level)) return false;
      if (source !== "all" && l.source !== source) return false;
      if (agent !== "all" && l.agent !== agent) return false;
      if (range !== null && now - l.ts > range) return false;
      if (q) {
        const hay = `${l.message} ${l.meta ?? ""} ${l.agent} ${l.source} ${l.kind}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [logs, levels, source, agent, rangeIdx, query]);

  // Streaming tail: keep the newest entry in view when enabled (no-op without data).
  React.useEffect(() => {
    if (tail && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [filtered, tail]);

  // Return to the first page whenever the filtered set changes (new filter or
  // new data), so a stale "load more" offset never applies to a different list.
  React.useEffect(() => {
    setVisibleCount(LOG_PAGE_SIZE);
  }, [filtered]);

  const visibleLogs = filtered.slice(0, visibleCount);
  const hasMoreLogs = visibleCount < filtered.length;

  const exportLogs = React.useCallback(() => {
    if (filtered.length === 0) return;
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cowork-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  const hasAnyLogs = logs.length > 0;
  const hasFiltered = filtered.length > 0;

  return (
    <div className="space-y-6">
      <ViewHeader
        title="Logs Explorer"
        description="Every log across all connected agents — filter by level, source, agent, and time."
        eyebrow="Observe"
        icon={<ScrollText className="size-5" />}
        actions={
          <>
            <Button
              type="button"
              variant={tail ? "default" : "outline"}
              size="sm"
              aria-pressed={tail}
              onClick={() => setTail((v) => !v)}
              className="gap-1.5"
            >
              {tail ? (
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 cowork-pulse" />
                  <span className="relative inline-flex size-2 rounded-full bg-current" />
                </span>
              ) : (
                <TerminalSquare className="size-4" aria-hidden />
              )}
              Streaming tail
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={exportLogs}
              disabled={!hasAnyLogs}
            >
              <Download className="size-4" aria-hidden />
              Export
            </Button>
          </>
        }
      />

      {/* Controls row */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex-1">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Full-text search messages, agents, sources…"
              ariaLabel="Search logs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={source} onValueChange={(v) => setSource(v as LogSource | "all")}>
              <SelectTrigger size="sm" className="h-9 w-[150px]" aria-label="Filter by source">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {ALL_SOURCES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger size="sm" className="h-9 w-[160px]" aria-label="Filter by agent">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={String(rangeIdx)} onValueChange={(v) => setRangeIdx(Number(v))}>
              <SelectTrigger size="sm" className="h-9 w-[150px]" aria-label="Filter by time range">
                <SelectValue placeholder="Time range" />
              </SelectTrigger>
              <SelectContent>
                {TIME_RANGES.map((r, i) => (
                  <SelectItem key={r.label} value={String(i)}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <LevelFilterChips active={levels} onToggle={toggleLevel} />
      </div>

      {/* Semantic legend (the 8 Signal Indigo --log-* tokens) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="cowork-eyebrow">Semantics</span>
        {ALL_KINDS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", LOG_KIND_META[k].dot)} aria-hidden />
            {LOG_KIND_META[k].label}
          </span>
        ))}
      </div>

      {/* Log feed */}
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {!hasAnyLogs ? (
          <ExtensionOnly
            title="Logs stream from the connected extension"
            description="When an Open Cowork extension is connected and an agent runs, every planner, navigator, tool, and observer event is logged here in real time. No logs are persisted yet, so this feed is on standby."
          />
        ) : !hasFiltered ? (
          <EmptyState
            icon={<ScrollText className="size-5" />}
            title="No matching logs"
            description="No log entries match the current filters. Try widening the time range or clearing a level filter."
          />
        ) : (
          <div
            ref={tailRef}
            className="cowork-scroll max-h-[60vh] overflow-auto rounded-xl border border-border bg-surface/40"
          >
            {visibleLogs.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
            {hasMoreLogs ? (
              <div className="flex items-center justify-center border-t border-border/60 p-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleCount((c) => c + LOG_PAGE_SIZE)}
                >
                  Load more ({filtered.length - visibleCount} hidden)
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </motion.div>
    </div>
  );
}

export default LogsExplorerView;
