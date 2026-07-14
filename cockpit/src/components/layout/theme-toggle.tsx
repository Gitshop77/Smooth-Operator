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

const THEMES = [
  { value: "light", Icon: Sun, label: "Light" },
  { value: "dark", Icon: Moon, label: "Dark" },
  { value: "system", Icon: Laptop, label: "System" },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useIsClientMounted();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${mounted ? (theme ?? "system") : "system"}`}
        >
          {mounted && theme === "dark" ? (
            <Moon className="size-4 transition-transform motion-reduce:transition-none" />
          ) : mounted && theme === "light" ? (
            <Sun className="size-4 transition-transform motion-reduce:transition-none" />
          ) : (
            <Laptop className="size-4 transition-transform motion-reduce:transition-none" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {THEMES.map(({ value, Icon, label }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            <Icon className="size-4" /> {label}
            {theme === value ? <Check className="size-4 ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
