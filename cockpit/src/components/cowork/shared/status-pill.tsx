"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "error" | "info" | "neutral" | "running";

const TONES: Record<Tone, string> = {
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-accent/10 text-accent border-accent/20",
  error: "bg-destructive/10 text-destructive border-destructive/20",
 // Distinct blue (#60A5FA dark / #2563EB light) — the spec's `--info`.
  info: "bg-info/10 text-info border-info/20",
  neutral: "bg-muted text-muted-foreground border-border",
  running: "bg-accent/10 text-accent border-accent/20",
};

interface StatusPillProps {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  pulse?: boolean;
}

export function StatusPill({
  tone = "neutral",
  children,
  className,
  pulse,
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {(pulse || tone === "running") ? (
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 cowork-pulse" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** Map common status strings to tones. */
export function toneForStatus(status: string): Tone {
  const s = status.toLowerCase();
  if (["ok", "online", "connected", "active", "interactive", "running", "approved", "completed", "done", "enabled", "strong", "very-strong", "success"].includes(s)) return "success";
  if (["idle", "loading", "pending", "thinking", "fair", "warn", "warning", "medium", "paused", "waiting-approval", "ready-to-resume"].includes(s)) return "warning";
  if (["error", "failed", "crashed", "blocked", "rejected", "weak", "critical", "offline", "disabled", "disabled-by-policy", "cancelled"].includes(s)) return "error";
  if (["info", "low", "log", "debug"].includes(s)) return "info";
  return "neutral";
}
