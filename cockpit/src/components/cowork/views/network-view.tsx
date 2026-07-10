"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Activity, Radio } from "lucide-react";

import { ViewHeader } from "@/components/cowork/shared/view-header";

/**
 * Network view — live network requests across all tabs.
 *
 * This capability is only available in the browser extension (which has
 * access to the `chrome.webRequest` API). The web cockpit cannot inspect
 * browser network traffic, so this view renders an instrument-readout style
 * standby state rather than a generic "feature missing" message.
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
        <div className="relative rounded-lg border overflow-hidden">
          {/* Wire-grid background suggesting a live instrument panel */}
          <div className="cowork-grid-bg min-h-[320px] flex flex-col items-center justify-center text-center gap-4 px-6 py-16">
            <div className="size-14 rounded-xl bg-primary/10 text-primary grid place-items-center">
              <Radio className="size-7" />
            </div>
            <div className="space-y-2 max-w-md">
              <p className="text-sm font-semibold cowork-mono">Instruments Standing By</p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Live network inspection requires the <span className="cowork-mono text-foreground/80">chrome.webRequest</span> API,
                available only inside the browser extension. Open the Cowork side panel to monitor network traffic in real&nbsp;time.
              </p>
            </div>
            {/* Simulated readout strip */}
            <div className="flex items-center gap-6 mt-4 text-muted-foreground/50 cowork-mono text-[10px] uppercase tracking-widest">
              <span>GET</span>
              <span>POST</span>
              <span>WS</span>
              <span>SSE</span>
              <span>XHR</span>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
