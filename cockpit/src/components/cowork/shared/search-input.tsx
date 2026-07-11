"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface SearchInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible label for the search field. Defaults to "Search". */
  ariaLabel?: string;
}

/**
 * Search field with an inline search glyph and an `aria-label`.
 *
 * Deduplicates the four hand-rolled `relative` + `<Search>` + `<Input>`
 * patterns across the views and guarantees the field is labeled for
 * assistive tech. Forwards a ref to the underlying `<input>`.
 */
export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onChange, placeholder = "Search…", ariaLabel = "Search", className, ...props }, ref) => {
    return (
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={ref}
          type="search"
          role="searchbox"
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn("pl-8 h-9", className)}
          {...props}
        />
      </div>
    );
  },
);
SearchInput.displayName = "SearchInput";
