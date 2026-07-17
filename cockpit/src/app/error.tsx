"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="mx-auto max-w-2xl p-6 my-8 rounded-lg border border-border bg-background"
    >
      <h2 className="text-lg font-semibold text-foreground">
        Something went wrong
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This section failed to render. Your session and cached data are intact.
      </p>
      <pre className="mt-3 max-h-40 overflow-auto rounded bg-muted/40 p-3 text-xs text-muted-foreground cowork-mono">
        {error?.message}
      </pre>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={reset}
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
