"use client";

import { cn } from "@/lib/utils";
import { useCoworkStore } from "@/hooks/use-cowork-store";

interface ConnectionStatusProps {
  className?: string;
  compact?: boolean;
}

/**
 * Small live indicator showing whether the WebSocket mini-service on port 3003
 * is connected. Uses the indigo accent (`text-accent` / `bg-accent`) when live.
 * Falls back to "offline" gracefully — the dashboard keeps working via polling.
 */
export function ConnectionStatus({ className, compact }: ConnectionStatusProps) {
  const connected = useCoworkStore((s) => s.socketConnected);
  const lastEvent = useCoworkStore((s) => s.lastEvent);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] cowork-mono",
        connected ? "text-accent" : "text-muted-foreground",
        className,
      )}
      title={lastEvent ?? (connected ? "Connected" : "Offline (polling)")}
      aria-live="polite"
    >
      <span className="relative flex size-2">
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-60",
            connected ? "bg-accent motion-safe:cowork-pulse" : "bg-muted-foreground/50",
          )}
        />
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            connected ? "bg-accent" : "bg-muted-foreground/70",
          )}
        />
      </span>
      <span className={cn(!compact && "hidden sm:inline", "sr-only")}>
        {connected ? "Live" : "Offline"}
      </span>
    </div>
  );
}
