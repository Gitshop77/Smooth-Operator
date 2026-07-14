"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

type StatTone = "default" | "success" | "danger" | "info" | "warn" | "accent";

// Severity-colored left accent border + value color. All values are Signal
// Indigo tokens (via the `--color-*` mapping in globals.css) — no hardcoded hex.
const TONE: Record<StatTone, { border: string; value: string }> = {
  default: { border: "border-l-border", value: "text-foreground" },
  success: { border: "border-l-success", value: "text-success" },
  danger: { border: "border-l-danger", value: "text-danger" },
  info: { border: "border-l-info", value: "text-info" },
  warn: { border: "border-l-warn", value: "text-warn" },
  accent: { border: "border-l-primary", value: "text-primary" },
};

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** Optional contextual delta line rendered under the value. */
  delta?: React.ReactNode;
  /** Optional icon shown on the right of the eyebrow row. */
  icon?: React.ReactNode;
  /** Accent color for the left border + value. Defaults to neutral. */
  tone?: StatTone;
  className?: string;
}

/**
 * Compact summary metric card used by the dashboard views (Tabs, Security).
 * Wraps the shared `Card` and applies a Signal Indigo severity/accent border.
 */
export function StatCard({
  label,
  value,
  delta,
  icon,
  tone = "default",
  className,
}: StatCardProps) {
  return (
    <Card
      title={typeof label === "string" ? label : undefined}
      className={cn(
        "p-3 gap-0.5 border-l-[3px]",
        TONE[tone].border,
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <p className="cowork-eyebrow truncate">{label}</p>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className={cn("text-xl font-semibold tnum", TONE[tone].value)}>{value}</p>
      {delta ? (
        <p className="text-xs text-muted-foreground tnum">{delta}</p>
      ) : null}
    </Card>
  );
}
