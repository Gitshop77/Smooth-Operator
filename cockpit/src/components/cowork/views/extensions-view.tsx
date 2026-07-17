"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Puzzle, FileJson, AlertCircle, RotateCcw } from "lucide-react";

import { useExtensions } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { ViewHeader } from "@/components/cowork/shared/view-header";
import { LoadingSkeleton } from "@/components/cowork/shared/loading-skeleton";
import { EmptyState } from "@/components/cowork/shared/empty-state";
import { formatBytes, timeAgo } from "@/lib/cowork-data/format";
import type { SampleExtension } from "@/lib/cowork-data/types";

// Parse `Extension.manifestJson` (a JSON-encoded string from Prisma) into a
// manifest object. Returns `{}` on parse failure or null input — never
// throws. The Prisma `Extension` model has no `permissions` column, so
// permissions are extracted from the parsed manifest's `permissions` array
// (Chrome MV3 manifest shape).
function parseManifest(ext: SampleExtension): Record<string, unknown> {
  const raw = ext.manifestJson;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function permissionsOf(manifest: Record<string, unknown>): string[] {
  const perms = manifest.permissions;
  if (!Array.isArray(perms)) return [];
  return perms.filter((p): p is string => typeof p === "string");
}

export function ExtensionsView() {
  const { data, isLoading, isError, refetch } = useExtensions();
  const [manifestFor, setManifestFor] = React.useState<string | null>(null);

  const manifestExt = React.useMemo(
    () => (data ?? []).find((e) => e.id === manifestFor),
    [data, manifestFor],
  );

  const manifests = React.useMemo(
    () => new Map((data ?? []).map((e) => [e.id, parseManifest(e)])),
    [data],
  );

  const manifest = manifestFor ? manifests.get(manifestFor) : undefined;
  const hasManifest = !!manifest && Object.keys(manifest).length > 0;

  return (
    <div className="space-y-4">
      <ViewHeader
        title="Extensions"
        description="Installed browser extensions"
        icon={<Puzzle className="size-5" />}
      />

      {isLoading ? (
        <LoadingSkeleton variant="cards" cardCount={5} />
      ) : isError ? (
        <EmptyState
          icon={<AlertCircle className="size-6" />}
          title="Couldn't load extensions"
          description="The extensions endpoint returned an error. Try again shortly."
          action={
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RotateCcw className="size-3.5 mr-1" /> Retry
            </Button>
          }
        />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Puzzle className="size-6" />}
          title="No extensions"
          description="Install extensions in Chrome to see them listed here. The cockpit dashboard is read-only."
        />
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="grid gap-4 grid-cols-1 md:grid-cols-2"
        >
          {(data ?? []).map((ext) => {
            const permissions = permissionsOf(manifests.get(ext.id) ?? {});
            return (
            <Card key={ext.id} className="p-5 gap-3">
              <div className="flex items-start gap-3">
                <div className="size-10 rounded-lg bg-primary/10 text-primary grid place-items-center shrink-0">
                  <Puzzle className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 justify-between">
                    <p className="font-semibold truncate">{ext.name}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {/* Prisma `Extension` has no `size` or `installedAt`
                        column; fall back to `createdAt` for the timestamp
                        and 0 for size. */}
                    v{ext.version} · <span className="tnum">{formatBytes(ext.size ?? 0)}</span> · installed {timeAgo(ext.createdAt)} ago
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground line-clamp-2">{ext.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {/* Prisma `Extension` has no `permissions` column —
                    extract from `manifestJson`. */}
                {permissions.map((p) => (
                  <Badge key={p} variant="secondary" className="text-[10px] font-mono">
                    {p}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center justify-end gap-1 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setManifestFor(ext.id)}
                >
                  <FileJson className="size-4" /> Manifest
                </Button>
              </div>
            </Card>
            );
          })}
        </motion.div>
      )}

      <Dialog open={!!manifestFor} onOpenChange={(o) => !o && setManifestFor(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileJson className="size-4" /> {manifestExt?.name} manifest
            </DialogTitle>
          </DialogHeader>
          {/* Parse `manifestJson` on demand; the parsed object is non-empty
              whenever the backend returned a real manifest. */}
          {hasManifest ? (
            <pre
              aria-label={`${manifestExt?.name ?? "extension"} manifest JSON`}
              className="text-xs font-mono bg-muted/50 rounded-md p-4 max-h-[60vh] overflow-auto cowork-scroll"
            >
{JSON.stringify(manifest, null, 2)}
            </pre>
          ) : (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Manifest not available. The backend has not returned a manifest
              for this extension.
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setManifestFor(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
