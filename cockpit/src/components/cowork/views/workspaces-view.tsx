"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { LayoutGrid, AlertCircle } from "lucide-react";

import { useWorkspaces } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";

export function WorkspacesView() {
  const { data, isLoading, isError, error } = useWorkspaces();
  const workspaces = data ?? [];

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Workspaces"
        description="Group tabs into focused workspaces"
        icon={<LayoutGrid className="size-5" />}
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" cardCount={6} />
      ) : isError ? (
        <EmptyState
          icon={<AlertCircle className="size-6" />}
          title="Couldn't load workspaces"
          description={error?.message ?? "The workspaces endpoint returned an error. Check that the backend is reachable and NEXT_PUBLIC_COWORK_UI_TOKEN is configured."}
        />
      ) : workspaces.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="size-6" />}
          title="No workspaces yet"
          description="Workspaces are created from the browser extension. The cockpit dashboard currently shows them read-only."
        />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        >
          {workspaces.map((ws) => (
            <Card key={ws.id} className="p-5 gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className="size-11 rounded-lg bg-muted grid place-items-center text-xl shrink-0"
                    aria-hidden="true"
                  >
                    {ws.icon}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{ws.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="tnum">{ws.tabCount ?? 0}</span> tabs
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </motion.div>
      )}
    </div>
  );
}
