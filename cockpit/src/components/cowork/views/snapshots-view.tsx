"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ListTree } from "lucide-react";

import { ViewHeader } from "@/components/cowork/shared/view-header";
import { ExtensionOnly } from "@/components/cowork/shared/extension-only";

/**
 * Snapshots view — accessibility tree of the active tab.
 *
 * This capability is only available in the browser extension (which can walk
 * the live DOM of the active tab). The web cockpit cannot snapshot a tab's
 * AX tree, so this view renders an informational state instead of always
 * erroring against a non-existent endpoint.
 */
export function SnapshotsView() {
  return (
    <div className="space-y-4">
      <ViewHeader
        title="Snapshots"
        description="Accessibility tree of the active tab"
        icon={<ListTree className="size-5" />}
      />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <ExtensionOnly
          title="Available in the extension only"
          description="Accessibility-tree snapshots require walking the live DOM of the active tab, which is only possible from the browser extension. Open the Cowork side panel to capture a snapshot."
        />
      </motion.div>
    </div>
  );
}
