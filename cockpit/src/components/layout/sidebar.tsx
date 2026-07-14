"use client";

import * as React from "react";
import { Hexagon, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useIsMobile } from "@/hooks/use-mobile";
import { NAV_GROUPS, type NavItem } from "@/components/layout/nav-config";
import { ConnectionStatus } from "@/components/layout/connection-status";
import { ThemeToggle } from "@/components/layout/theme-toggle";

interface SidebarProps {
  className?: string;
  onNavigate?: () => void;
  /** Force the expanded (labelled) layout even when the store says collapsed. */
  forceExpanded?: boolean;
}

/**
 * Sidebar contents — used both by the desktop fixed sidebar and the mobile
 * Sheet drawer. `onNavigate` lets the mobile drawer close itself after a tap.
 * `forceExpanded` keeps the mobile drawer labelled regardless of collapse state.
 *
 * Signal Indigo design: calm, indigo-accented. Active item gets a strong
 * indigo contrast (subtle accent fill + accent text + a left accent bar).
 * The desktop sidebar supports collapse/expand to an icon-only rail.
 */
export function Sidebar({ className, onNavigate, forceExpanded }: SidebarProps) {
  const currentView = useCoworkStore((s) => s.currentView);
  const collapsed = useCoworkStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = useCoworkStore((s) => s.toggleSidebarCollapsed);
  const isMobile = useIsMobile();

  const isCollapsed = collapsed && !isMobile && !forceExpanded;

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border motion-reduce:transition-none",
        isCollapsed ? "w-16" : "w-60",
        className,
      )}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-sidebar-border shrink-0">
        <h2 className="sr-only">Open Cowork</h2>
        <div className="size-7 rounded-[10px] bg-accent text-accent-foreground grid place-items-center shrink-0">
          <Hexagon className="size-4" />
        </div>
        {!isCollapsed ? (
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm leading-tight truncate">Open Cowork</p>
            <p className="text-[11px] leading-tight truncate text-muted-foreground">
              Cockpit
            </p>
          </div>
        ) : null}
        {!isMobile ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={isCollapsed}
            className="size-7 grid place-items-center rounded-md text-muted-foreground hover:text-sidebar-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
          >
            {isCollapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        ) : null}
      </div>

      {/* Nav */}
      <nav
        className="flex-1 overflow-y-auto cowork-scroll px-3 py-4 space-y-5"
        aria-label="Dashboard navigation"
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className={cn(isCollapsed ? "space-y-1" : "space-y-0.5")}>
            {!isCollapsed ? (
              <p className="cowork-eyebrow px-2 pb-1.5">{group.label}</p>
            ) : null}
            {group.items.map((item) => (
              <NavItemButton
                key={item.id}
                item={item}
                active={currentView === item.id}
                isCollapsed={isCollapsed}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* Footer of sidebar */}
      <div
        className={cn(
          "border-t border-sidebar-border px-3 py-2 flex items-center gap-2 shrink-0",
          isCollapsed ? "flex-col" : "justify-between",
        )}
      >
        <ConnectionStatus compact={isCollapsed} />
        <ThemeToggle />
      </div>
    </div>
  );
}

const NavItemButton = React.memo(function NavItemButton({
  item,
  active,
  isCollapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  isCollapsed: boolean;
  onNavigate?: () => void;
}) {
  const setView = useCoworkStore((s) => s.setView);
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => {
        setView(item.id);
        onNavigate?.();
      }}
      title={isCollapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      aria-label={item.label}
      className={cn(
        "w-full flex items-center rounded-[10px] text-[13px] font-medium transition-colors relative active:scale-[0.98]",
        isCollapsed
          ? "justify-center size-9"
          : "gap-2.5 px-2.5 py-1.5 min-h-[34px] text-left",
        active
          ? "bg-accent-subtle text-accent"
          : "text-muted-foreground hover:bg-muted hover:text-sidebar-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {active ? (
        <span
          className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r bg-accent"
          aria-hidden="true"
        />
      ) : null}
      <Icon
        className={cn(
          "size-4 shrink-0 transition-colors",
          active ? "text-accent" : "text-muted-foreground",
        )}
      />
      {!isCollapsed ? <span className="truncate">{item.label}</span> : null}
    </button>
  );
});
