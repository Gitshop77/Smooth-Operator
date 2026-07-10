"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Workflow as WorkflowIcon, Clock, ChevronRight } from "lucide-react";

import { useWorkflows } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { timeAgo } from "@/lib/cowork-data/format";

export function WorkflowsView() {
  const { data, isLoading } = useWorkflows();

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Workflows"
        description="Automated multi-step browser flows"
        icon={<WorkflowIcon className="size-5" />}
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" cardCount={4} />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<WorkflowIcon className="size-6" />}
          title="No workflows defined"
          description="Workflows are created via POST /api/cowork/workflows. The cockpit dashboard is currently read-only."
        />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 lg:grid-cols-2"
        >
          {(data ?? []).map((wf) => {
            // `stepsJson` is a JSON-encoded string from Prisma (NOT an
            // array). Parse defensively (default to [] on parse error) so a
            // malformed row never crashes the whole view. The schema documents
            // the element type as `WorkflowStep[]` — objects with `{ name?,
            // action? }` — but historical rows may carry bare-string labels,
            // so the renderer falls back to `String(s)` for back-compat.
            const steps: Array<{ name?: string; action?: string }> = (() => {
              const raw = wf.stepsJson;
              if (Array.isArray(raw)) return raw as Array<{ name?: string; action?: string }>;
              if (typeof raw !== "string") return [];
              try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed)
                  ? (parsed as Array<{ name?: string; action?: string }>)
                  : [];
              } catch {
                return [];
              }
            })();
            return (
            <Card key={wf.id} className="p-5 gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold truncate">{wf.name}</p>
                    <StatusPill tone={wf.enabled ? "success" : "neutral"}>
                      {wf.enabled ? "enabled" : "disabled"}
                    </StatusPill>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{wf.description}</p>
                </div>
              </div>

              {steps.length > 0 && (
                <ol className="flex flex-wrap items-center gap-1.5 text-xs">
                  {steps.map((s, i) => (
                    <React.Fragment key={i}>
                      <li className="px-2 py-1 rounded-md bg-muted text-muted-foreground">
                        <span className="tnum text-foreground/70 mr-1">{i + 1}.</span>
                        {s.name ?? s.action ?? String(s)}
                      </li>
                      {i < steps.length - 1 ? (
                        <ChevronRight className="size-3 text-muted-foreground/50" />
                      ) : null}
                    </React.Fragment>
                  ))}
                </ol>
              )}

              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {wf.lastRun ? (
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" /> last {timeAgo(wf.lastRun)} ago
                    </span>
                  ) : (
                    <span>never run</span>
                  )}
                </div>
              </div>
            </Card>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}
