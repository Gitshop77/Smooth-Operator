"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { TerminalSquare, Puzzle } from "lucide-react";

import { ViewHeader } from "@/components/cowork/shared/view-header";
import { EmptyState } from "@/components/cowork/shared/empty-state";

/**
 * DevTools view — console output per tab.
 *
 * This capability is only available in the browser extension (which can
 * inject content scripts that capture `console.*` calls). The web cockpit
 * cannot read a tab's console, so this view renders an informational state
 * instead of always erroring against a non-existent endpoint.
 */
export function DevToolsView() {
  return (
    <div className="space-y-4">
      <ViewHeader
        title="DevTools"
        description="Console output per tab"
        icon={<TerminalSquare className="size-5" />}
      />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <EmptyState
          icon={<Puzzle className="size-6" />}
          title="Available in the extension only"
          description="Per-tab console capture requires a content script running inside the target page, which is only possible from the browser extension. Open the Cowork side panel to view console logs."
        />
      </motion.div>
    </div>
  );
}
