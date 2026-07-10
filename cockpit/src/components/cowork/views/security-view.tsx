"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldX, ShieldAlert, Filter } from "lucide-react";

import { useSecurityEvents } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/cowork/shared/data-table";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { timeAgo } from "@/lib/cowork-data/format";

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
        title="Security"
        description="Live security event feed"
        eyebrow="Secure"
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
                  {t === "all" ? "All Types" : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* Summary cards with severity-colored left borders */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card className="p-3 gap-0.5 border-l-[3px] border-l-muted-foreground/30">
          <p className="cowork-eyebrow">Total</p>
          <p className="text-xl font-semibold tnum">{data?.length ?? 0}</p>
        </Card>
        <Card className="p-3 gap-0.5 border-l-[3px] border-l-destructive">
          <p className="cowork-eyebrow">Blocked</p>
          <p className="text-xl font-semibold tnum text-destructive">{blocked}</p>
        </Card>
        <Card className="p-3 gap-0.5 border-l-[3px] border-l-chart-2">
          <p className="cowork-eyebrow">Allowed</p>
          <p className="text-xl font-semibold tnum text-chart-2">{allowed}</p>
        </Card>
        <Card className="p-3 gap-0.5 border-l-[3px] border-l-chart-1">
          <p className="cowork-eyebrow">Critical</p>
          <p className="text-xl font-semibold tnum text-chart-1">{critical}</p>
        </Card>
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          <ShieldCheck className="size-7 mx-auto mb-2 text-chart-2" />
          <p className="cowork-mono">No Security Events</p>
          <p className="mt-1 text-muted-foreground text-xs">No events match your current filter.</p>
        </Card>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          <DataTable caption="Security events" columns={["Severity", "Type", "Description", "Domain", "Action", "When"]}>
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
                      <ShieldX className="size-3.5" /> blocked
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] cowork-mono text-chart-2">
                      <ShieldAlert className="size-3.5" /> allowed
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-[11px] cowork-mono text-muted-foreground tnum whitespace-nowrap">
                  {timeAgo(e.timestamp)} ago
                </td>
              </tr>
            ))}
          </DataTable>
        </motion.div>
      )}
    </div>
  );
}
