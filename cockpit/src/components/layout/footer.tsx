"use client";

import * as React from "react";

import { ConnectionStatus } from "@/components/layout/connection-status";
import { COCKPIT_VERSION } from "@/lib/cowork/version";

/**
 * Minimal status footer.
 *
 * The parent shell wraps the whole app in `min-h-screen flex flex-col` and
 * the main content area is `flex-1`, so this footer with `mt-auto` always
 * sits at the bottom of the viewport when content is short, and gets pushed
 * down by long content.
 */
export function Footer() {
  return (
    <footer className="mt-auto border-t border-border bg-background/80 backdrop-blur-sm px-4 sm:px-6 py-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground/80">Cowork Cockpit</span>
          <span
            className="cowork-mono text-[10px] text-muted-foreground"
            aria-label="Version"
          >
            v{COCKPIT_VERSION}
          </span>
        </div>
        <ConnectionStatus compact />
      </div>
    </footer>
  );
}
