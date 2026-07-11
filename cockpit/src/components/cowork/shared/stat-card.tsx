"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

type StatTone = "default" | "success" | "danger" | "info" | "warn" | "accent";

// Severity-colored left accent border. All values are Signal Indigo tokens
// (via the `--color-*` mapping in globals.css) — no hardcoded hex.
const TONE_BORDER: Record<StatTone, string> = {
  default: "border-l-border",
  success: "border-l-success",
  danger: "border-l-danger",
  info: "border-l-info",
  warn: "border-l-warn",
  accent: "border-l-primary",
};

const TONE_VALUE: Record<StatTone, string> = {
  default: "text-foreground",
  success: "text-success",
  danger: "text-danger",
  info: "text-info",
  warn: "text-warn",
  accent: "text-primary",
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
      className={cn(
        "p-3 gap-0.5 border-l-[3px]",
        TONE_BORDER[tone],
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="cowork-eyebrow">{label}</p>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className={cn("text-xl font-semibold tnum", TONE_VALUE[tone])}>{value}</p>
      {delta ? (
        <p className="text-xs text-muted-foreground tnum">{delta}</p>
      ) : null}
    </Card>
  );
}
