"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Boxes, Cookie, Smartphone, EyeOff } from "lucide-react";

import { useSessions } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { StatusPill } from "@/components/cowork/shared/status-pill";
import { timeAgo } from "@/lib/cowork-data/format";

export function SessionsView() {
  const { data, isLoading } = useSessions();

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Sessions"
        description="Isolated browser sessions with their own cookies and storage"
        icon={<Boxes className="size-5" />}
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" cardCount={4} />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Boxes className="size-6" />}
          title="No sessions"
          description="Sessions are created via POST /api/cowork/sessions. The cockpit dashboard is currently read-only."
        />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 md:grid-cols-2"
        >
          {(data ?? []).map((s) => (
            <Card key={s.id} className="p-5 gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold truncate">{s.name}</p>
                    {s.incognito ? (
                      <StatusPill tone="warning">
                        <EyeOff className="size-3" /> incognito
                      </StatusPill>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground font-mono mt-1">{s.partition}</p>
                </div>
              </div>
              <div className="space-y-2 pt-1 text-xs">
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Smartphone className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{s.userAgent}</span>
                </p>
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Cookie className="size-3.5 shrink-0" />
                  <span><span className="tnum text-foreground font-medium">{s.cookieCount}</span> cookies</span>
                  <span className="ml-auto">created {timeAgo(s.createdAt)} ago</span>
                </p>
              </div>
            </Card>
          ))}
        </motion.div>
      )}
    </div>
  );
}
