"use client";

import { Plug } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ExtensionOnlyProps {
  /** Heading for the standby panel. */
  title?: string;
  /** Supporting copy explaining why the view is empty. */
  description?: string;
  className?: string;
}

/**
 * Standby panel for extension-only views shown when no live extension data
 * is present. Renders a consistent "connect the extension" message + CTA and
 * replaces the ad-hoc empty markup that previously lived in several views.
 */
export function ExtensionOnly({
  title = "Extension-only view",
  description = "This view reflects live data from the Open Cowork browser extension. Connect the extension to see it here.",
  className,
}: ExtensionOnlyProps) {
  return (
    <Card
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center",
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Plug className="size-6" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" size="sm" className="mt-1">
        Connect the Open Cowork extension
      </Button>
    </Card>
  );
}
