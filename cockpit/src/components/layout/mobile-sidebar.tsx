"use client";

import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import { Sidebar } from "@/components/layout/sidebar";
import { useCoworkStore } from "@/hooks/use-cowork-store";
import { useIsMobile } from "@/hooks/use-mobile";

export function MobileSidebar() {
  const isMobile = useIsMobile();
  const open = useCoworkStore((s) => s.sidebarOpen);
  const setOpen = useCoworkStore((s) => s.setSidebar);

  if (!isMobile) return null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation menu"
          className="md:hidden size-8 -ml-1.5 text-muted-foreground hover:text-foreground"
        >
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-60 p-0 border-border">
        <SheetTitle className="sr-only">Open Cowork Navigation</SheetTitle>
        <Sidebar onNavigate={() => setOpen(false)} className="border-r-0" forceExpanded />
      </SheetContent>
    </Sheet>
  );
}
