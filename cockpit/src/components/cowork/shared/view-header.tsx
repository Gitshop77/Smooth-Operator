"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface ViewHeaderProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Small label above the title (e.g. "Inspect", "Browsing") */
  eyebrow?: string;
  className?: string;
}

/**
 * Reusable header at the top of every dashboard view.
 * Calm, minimal: small sentence-case eyebrow, terracotta-tinted icon chip,
 * generous whitespace.
 */
export function ViewHeader({
  title,
  description,
  icon,
  actions,
  eyebrow,
  className,
}: ViewHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6",
        className,
      )}
    >
      <div className="flex items-start gap-3 min-w-0">
        {icon ? (
          <div className="size-9 shrink-0 rounded-[10px] bg-primary/10 text-primary grid place-items-center">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? (
            <p className="cowork-eyebrow mb-1">{eyebrow}</p>
          ) : null}
          <h1 className="text-xl font-semibold tracking-tight truncate">{title}</h1>
          {description ? (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </motion.div>
  );
}
