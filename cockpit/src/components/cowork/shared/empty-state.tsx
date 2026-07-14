"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center gap-3 py-16 px-6 rounded-2xl border border-dashed border-border bg-muted/30 animate-in fade-in-0 motion-reduce:animate-none",
        className,
      )}
    >
      {icon ? (
        <div className="size-12 rounded-2xl bg-muted text-muted-foreground grid place-items-center" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-foreground" role="heading" aria-level={2}>{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
