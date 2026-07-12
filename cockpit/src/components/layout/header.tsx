"use client";

import { useCoworkStore } from "@/hooks/use-cowork-store";
import { VIEW_META } from "@/components/layout/nav-config";
import { MobileSidebar } from "@/components/layout/mobile-sidebar";

/**
 * Sticky top header — calm translucent strip with a hairline bottom border.
 * Shows current view icon + title, description on md+.
 */
export function Header() {
  const currentView = useCoworkStore((s) => s.currentView);
  const meta = VIEW_META[currentView];
  const Icon = meta?.icon;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 backdrop-blur-sm supports-[backdrop-filter]:bg-background/65 px-4 sm:px-6">
      <MobileSidebar />
      <div className="flex items-center gap-2 min-w-0">
        {Icon ? <Icon className="size-4 text-accent shrink-0" /> : null}
        <h1 className="font-semibold text-sm truncate">{meta?.label ?? "Cowork"}</h1>
        <span className="hidden md:inline text-[13px] text-muted-foreground truncate">
          {meta?.description}
        </span>
      </div>
    </header>
  );
}
