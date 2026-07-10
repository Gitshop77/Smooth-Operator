"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface DataTableProps {
  columns: React.ReactNode[];
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  /** Visually-hidden caption used for table semantics / screen readers. */
  caption?: string;
}

/**
 * Lightweight table wrapper used by the table-style views (Tabs, Network,
 * DevTools, Security). Soft header, subtle row dividers, tabular numerals.
 * Column labels are sentence-case sans (not monospace, not all-caps).
 */
export function DataTable({
  columns,
  children,
  className,
  containerClassName,
  caption,
}: DataTableProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card overflow-hidden",
        className,
      )}
    >
      <div className={cn("max-h-[72vh] overflow-auto cowork-scroll", containerClassName)}>
        <table className="w-full text-sm tnum" aria-label={caption}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm">
            <tr className="border-b border-border">
              {columns.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  className="text-left font-medium text-muted-foreground px-4 py-2.5 whitespace-nowrap text-[12px]"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">{children}</tbody>
        </table>
      </div>
    </div>
  );
}
