"use client";

import * as React from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { redactSecrets } from "@/lib/cowork/api/http";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches uncaught render errors anywhere in the dashboard tree so a single
 * bad payload or thrown selector degrades to a recoverable fallback panel
 * instead of white-screening the whole cockpit. The query cache (owned by the
 * parent QueryClientProvider) stays alive across resets.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Redacted observability: route label + message only, never secret material.
    console.error(
      "[AppErrorBoundary] view render failure:",
      redactSecrets(error?.message ?? ""),
      redactSecrets(info?.componentStack ?? ""),
    );
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="mx-auto max-w-2xl p-6 my-8 rounded-lg border border-border bg-background"
        >
          <h2 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            A view failed to render. Your session and cached data are intact.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded bg-muted/40 p-3 text-xs text-muted-foreground cowork-mono">
            {redactSecrets(this.state.error.message)}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * CoworkProviders — wraps the app with the TanStack Query client.
 * Kept separate from layout.tsx so the root layout can stay a server component.
 */
export function CoworkProviders({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <AppErrorBoundary>{children}</AppErrorBoundary>
    </QueryClientProvider>
  );
}
