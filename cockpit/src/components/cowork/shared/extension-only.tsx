"use client";

import * as React from "react";
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
  /** When provided, wires the CTA to actually connect; otherwise it is disabled. */
  onConnect?: () => void;
}

/**
 * Standby panel for extension-only views shown when no live extension data
 * is present. Renders a consistent "connect the extension" message + CTA and
 * replaces the ad-hoc empty markup that previously lived in several views.
 */
export const ExtensionOnly = React.memo(function ExtensionOnly({
  title = "Extension-only view",
  description = "This view reflects live data from the Open Cowork browser extension. Connect the extension to see it here.",
  className,
  onConnect,
}: ExtensionOnlyProps) {
  return (
    <Card
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center",
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary" aria-hidden="true">
        <Plug className="size-6" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Button variant="outline" size="sm" type="button" className="mt-1" onClick={onConnect} disabled={!onConnect}>
        Connect the Open Cowork extension
      </Button>
    </Card>
  );
});
