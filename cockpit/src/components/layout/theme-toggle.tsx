"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Laptop, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// SSR-safe "are we mounted on the client?" detection without
// setState-in-effect. `useSyncExternalStore` with a no-op subscribe + a
// client snapshot of `true` + a server snapshot of `false` returns `false`
// during SSR and the first client render, then `true` on the second client
// render — exactly the old `useEffect(() => setMounted(true))` semantics,
// without the cascading-render warning. The subscribe function never throws
// and never actually subscribes (the value can never change).
function subscribeNoop() {
  return () => {};
}
function useIsClientMounted() {
  return React.useSyncExternalStore(subscribeNoop, () => true, () => false);
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useIsClientMounted();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          {mounted && theme === "dark" ? (
            <Moon className="size-4" />
          ) : mounted && theme === "light" ? (
            <Sun className="size-4" />
          ) : (
            <Laptop className="size-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="size-4" /> Light
          {theme === "light" ? <Check className="size-4 ml-auto" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="size-4" /> Dark
          {theme === "dark" ? <Check className="size-4 ml-auto" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Laptop className="size-4" /> System
          {theme === "system" ? <Check className="size-4 ml-auto" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
