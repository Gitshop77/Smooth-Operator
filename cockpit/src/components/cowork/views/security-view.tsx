"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldX, ShieldAlert, Filter } from "lucide-react";

import { useSecurityEvents } from "@/hooks/use-cowork-query";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/cowork/shared/data-table";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { StatCard } from "@/components/cowork/shared/stat-card";
import { timeAgo } from "@/lib/cowork-data/format";

// The Cockpit app has no app-wide i18n layer yet (see FULL-REVIEW.md §21 —
// "Cockpit web app has no i18n layer; all user-facing strings are
// hard-coded"). To make a future locale-catalog/`t()` migration cheap, this
// view's user-facing strings are centralized here in a single English catalog
// rather than scattered as inline literals across the JSX. Swapping this object
// for a localized lookup is the only change this file will need once the shared
// i18n helper exists.
const MESSAGES = {
  title: "Security",
  description: "Live security event feed",
  eyebrow: "Secure",
  filterAllTypes: "All Types",
  statTotal: "Total",
  statBlocked: "Blocked",
  statAllowed: "Allowed",
  statCritical: "Critical",
  emptyTitle: "No Security Events",
  emptyDescription: "No events match your current filter.",
  tableCaption: "Security events",
  colSeverity: "Severity",
  colType: "Type",
  colDescription: "Description",
  colDomain: "Domain",
  colAction: "Action",
  colWhen: "When",
  actionBlocked: "blocked",
  actionAllowed: "allowed",
  whenSuffix: "ago",
} as const;

const SEVERITY_TONE: Record<string, "error" | "warning" | "info"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "info",
 // The Prisma `SecurityEvent.severity` field also allows `'info'`
 // (see schema.prisma). Map to the `info` tone so info events render
 // distinctly from `low`.
  info: "info",
};

/** Map severity to the CSS border class. */
const SEVERITY_BORDER: Record<string, string> = {
  critical: "border-l-[3px] border-l-destructive",
  high: "border-l-[3px] border-l-destructive",
  medium: "border-l-[3px] border-l-chart-1",
  low: "border-l-[3px] border-l-muted-foreground/30",
 // Match SEVERITY_TONE — give info-severity rows a neutral border.
  info: "border-l-[3px] border-l-muted-foreground/30",
};

export function SecurityView() {
  const { data, isLoading } = useSecurityEvents();
  const [typeFilter, setTypeFilter] = React.useState("all");

  const types = React.useMemo(() => {
    const set = new Set<string>();
    (data ?? []).forEach((e) => set.add(e.type));
    return ["all", ...Array.from(set).sort()];
  }, [data]);

  const rows = React.useMemo(() => {
 // `timestamp` arrives as an ISO string (Prisma DateTime → JSON
 // serializes to string). Coerce to ms via `new Date(...).getTime()` so
 // the sort is stable.
    const all = (data ?? []).slice().sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    if (typeFilter === "all") return all;
    return all.filter((e) => e.type === typeFilter);
  }, [data, typeFilter]);

  const blocked = (data ?? []).filter((e) => e.blocked).length;
  const allowed = (data ?? []).length - blocked;
  const critical = (data ?? []).filter((e) => e.severity === "critical").length;

  return (
    <div className="space-y-4">
      <ViewHeader
        title={MESSAGES.title}
        description={MESSAGES.description}
        eyebrow={MESSAGES.eyebrow}
        icon={<ShieldCheck className="size-5" />}
        actions={
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-44 text-sm" size="sm" aria-label="Filter by type">
              <Filter className="size-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === "all" ? MESSAGES.filterAllTypes : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* Summary cards with severity-colored left borders */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatCard label={MESSAGES.statTotal} value={data?.length ?? 0} />
        <StatCard label={MESSAGES.statBlocked} value={blocked} tone="danger" />
        <StatCard label={MESSAGES.statAllowed} value={allowed} tone="success" />
        <StatCard label={MESSAGES.statCritical} value={critical} tone="danger" />
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="size-6" />}
          title={MESSAGES.emptyTitle}
          description={MESSAGES.emptyDescription}
        />
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          <DataTable caption={MESSAGES.tableCaption} columns={[MESSAGES.colSeverity, MESSAGES.colType, MESSAGES.colDescription, MESSAGES.colDomain, MESSAGES.colAction, MESSAGES.colWhen]}>
            {rows.map((e) => (
              <tr
                key={e.id}
                className={`hover:bg-accent/40 transition-colors align-top ${SEVERITY_BORDER[e.severity] ?? ""}`}
              >
                <td className="px-4 py-2.5">
                  <StatusPill tone={SEVERITY_TONE[e.severity]}>{e.severity}</StatusPill>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-[11px] cowork-mono">{e.type}</span>
                </td>
                <td className="px-4 py-2.5 min-w-[260px]">
                  <p className="text-sm leading-snug">{e.description}</p>
                </td>
                <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground">{e.domain}</td>
                <td className="px-4 py-2.5">
                  {e.blocked ? (
                    <span className="inline-flex items-center gap-1 text-[11px] cowork-mono text-destructive">
                      <ShieldX className="size-3.5" /> {MESSAGES.actionBlocked}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] cowork-mono text-success">
                      <ShieldAlert className="size-3.5" /> {MESSAGES.actionAllowed}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                  {timeAgo(e.timestamp)} {MESSAGES.whenSuffix}
                </td>
              </tr>
            ))}
          </DataTable>
        </motion.div>
      )}
    </div>
  );
}
