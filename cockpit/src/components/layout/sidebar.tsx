"use client";

import * as React from "react";
import { Hexagon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import { NAV_GROUPS } from "@/components/layout/nav-config";
import { ConnectionStatus } from "@/components/layout/connection-status";
import { ThemeToggle } from "@/components/layout/theme-toggle";

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
}

/**
 * Sidebar contents — used both by the desktop fixed sidebar and the mobile
 * Sheet drawer. `onNavigate` lets the mobile drawer close itself after a tap.
 *
 * Design: calm, warm, minimal. Sentence-case group labels, soft active state
 * (subtle background, no harsh left rail), generous whitespace.
 */
export function Sidebar({ className, onNavigate }: SidebarProps) {
  const currentView = useCoworkStore((s) => s.currentView);
  const setView = useCoworkStore((s) => s.setView);

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border",
        className,
      )}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-sidebar-border shrink-0">
        <div className="size-7 rounded-[10px] bg-primary text-primary-foreground grid place-items-center">
          <Hexagon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-sm leading-tight truncate">Cockpit</p>
          <p className="text-[11px] leading-tight truncate text-muted-foreground">
            Open Cowork
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav
        className="flex-1 overflow-y-auto cowork-scroll px-3 py-4 space-y-5"
        aria-label="Dashboard navigation"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-0.5">
            <p className="cowork-eyebrow px-2 pb-1.5">
              {group.label}
            </p>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = currentView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setView(item.id);
                    onNavigate?.();
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-[13px] font-medium transition-colors min-h-[34px] text-left",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0 transition-colors",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer of sidebar */}
      <div className="border-t border-sidebar-border px-3 py-2 flex items-center justify-between shrink-0">
        <ConnectionStatus />
        <ThemeToggle />
      </div>
    </div>
  );
}
