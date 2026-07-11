"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Activity } from "lucide-react";

import { ViewHeader } from "@/components/cowork/shared/view-header";
import { ExtensionOnly } from "@/components/cowork/shared/extension-only";

/**
 * Network view — live network requests across all tabs.
 *
 * This capability is only available in the browser extension (which has
 * access to the `chrome.webRequest` API). The web cockpit cannot inspect
 * browser network traffic, so this view renders the shared extension-only
 * standby panel rather than a generic "feature missing" message.
 */
export function NetworkView() {
  return (
    <div className="space-y-4">
      <ViewHeader
        title="Network"
        description="Live network requests across all tabs"
        eyebrow="Inspect"
        icon={<Activity className="size-5" />}
      />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
        <ExtensionOnly
          title="Available in the extension only"
          description="Live network inspection requires the chrome.webRequest API, which is only available inside the browser extension. Open the Cowork side panel to monitor network traffic in real time."
        />
      </motion.div>
    </div>
  );
}
