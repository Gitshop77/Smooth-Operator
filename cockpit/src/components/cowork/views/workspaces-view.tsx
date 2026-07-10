"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { LayoutGrid } from "lucide-react";

import { useWorkspaces } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";

export function WorkspacesView() {
  const { data, isLoading } = useWorkspaces();

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Workspaces"
        description="Group tabs into focused workspaces"
        icon={<LayoutGrid className="size-5" />}
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" cardCount={6} />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="size-6" />}
          title="No workspaces yet"
          description="Workspaces are created via POST /api/cowork/workspaces. The cockpit dashboard is currently read-only."
        />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        >
          {(data ?? []).map((ws) => (
            <Card key={ws.id} className="p-5 gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-11 rounded-lg bg-muted grid place-items-center text-xl shrink-0">
                    {ws.icon}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{ws.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="tnum">{ws.tabCount}</span> tabs
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">Idle</span>
              </div>
            </Card>
          ))}
        </motion.div>
      )}
    </div>
  );
}
