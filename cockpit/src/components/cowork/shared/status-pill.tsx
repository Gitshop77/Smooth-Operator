"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "error" | "info" | "neutral" | "running";

// warning and running reuse the accent token for visual emphasis.
const ACCENT_TONE = "bg-accent/10 text-accent border-accent/20";

const TONES: Record<Tone, string> = {
  success: "bg-success/10 text-success border-success/20",
  warning: ACCENT_TONE,
  error: "bg-destructive/10 text-destructive border-destructive/20",
  // Info tone — informational/low-severity statuses.
  info: "bg-info/10 text-info border-info/20",
  neutral: "bg-muted text-muted-foreground border-border",
  running: ACCENT_TONE,
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
        <span className="relative flex size-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 cowork-pulse" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** Map common status strings to tones. */
const STATUS_TONE: Record<string, Tone> = {
  ok: "success", online: "success", connected: "success", active: "success",
  interactive: "success", running: "success", approved: "success",
  completed: "success", done: "success", enabled: "success", strong: "success",
  "very-strong": "success", success: "success",
  idle: "warning", loading: "warning", pending: "warning", thinking: "warning",
  fair: "warning", warn: "warning", warning: "warning", medium: "warning",
  paused: "warning", "waiting-approval": "warning", "ready-to-resume": "warning",
  error: "error", failed: "error", crashed: "error", blocked: "error",
  rejected: "error", weak: "error", critical: "error", offline: "error",
  disabled: "error", "disabled-by-policy": "error", cancelled: "error",
  info: "info", low: "info", log: "info", debug: "info",
};

export function toneForStatus(status: string): Tone {
  return STATUS_TONE[(status ?? "").toLowerCase()] ?? "neutral";
}
