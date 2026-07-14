"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

interface LoadingSkeletonProps {
  rows?: number;
  className?: string;
  variant?: "table" | "cards";
  cardCount?: number;
}

export const LoadingSkeleton = React.memo(function LoadingSkeleton({
  rows = 6,
  className,
  variant = "table",
  cardCount = 6,
}: LoadingSkeletonProps) {
  if (variant === "cards") {
    return (
      <div
        role="status"
        aria-busy="true"
        className={cn(
          "grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 animate-in fade-in-0 motion-reduce:animate-none",
          className,
        )}
      >
        {Array.from({ length: cardCount }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <Skeleton className="h-3 w-2/3" aria-hidden="true" />
            <Skeleton className="h-3 w-1/2" aria-hidden="true" />
            <Skeleton className="h-7 w-full" aria-hidden="true" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        "rounded-2xl border border-border bg-card overflow-hidden animate-in fade-in-0 motion-reduce:animate-none",
        className,
      )}
    >
      <div className="border-b border-border px-4 py-3 bg-muted/40">
        <Skeleton className="h-3 w-1/4" aria-hidden="true" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3 flex items-center gap-4">
            <Skeleton className="h-3 w-8" aria-hidden="true" />
            <Skeleton className="h-3 flex-1 max-w-sm" aria-hidden="true" />
            <Skeleton className="h-3 w-20 hidden sm:block" aria-hidden="true" />
            <Skeleton className="h-5 w-14" aria-hidden="true" />
          </div>
        ))}
      </div>
    </div>
  );
});
