import type { BrowserState } from "../../types";
import type { LoaderRunResult } from "../../dom/navigation/url-loaders";
import { domFingerprint } from "../helpers";

/** Immutable background dispatch identity carried by content-originated RPCs. */
export interface ActionDispatchToken {
  runId: string;
  dispatchRevision: number;
}

export interface ActionContext {
  state: BrowserState;
  beforeUrl: string;
  /**
   * Lazily-computed DOM fingerprint of the page BEFORE this action ran. Most
   * actions never call {@link hasPageChanged}, so the O(interactive-elements)
   * scan+hash is deferred until the first read and memoized for the action's
   * lifetime — `domFingerprint()` runs at most once per action, never eagerly.
   */
  beforeFingerprint: string;
  signal?: AbortSignal;
  /** Present only for an authoritative background EXECUTE_ACTIONS dispatch. */
  dispatchToken?: ActionDispatchToken;
  /** Opaque one-action proof issued by the authoritative background. */
  effectCapability?: string;
  /** True when this action originates from a URL-loader step — used as the
   * recursion guard so loader steps never re-trigger loaders on their own
   * navigation. */
  fromLoader?: boolean;
}

/** Runs the URL loaders matching a freshly-navigated URL (S6). */
export type LoaderRunner = (url: string) => Promise<LoaderRunResult>;

export function isExtensionContext(): boolean {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

/** Lazy fingerprint holder — memoizes the first `domFingerprint()` read. */
export interface LazyFingerprint {
  get(): string;
}

export function makeLazyFingerprint(): LazyFingerprint {
  let cached: string | undefined;
  return {
    get(): string {
      if (cached === undefined) cached = domFingerprint();
      return cached;
    },
  };
}

export function hasPageChanged(ctx: ActionContext): boolean {
  if (location.href !== ctx.beforeUrl) return true;
  return resolveBeforeFingerprint(ctx) !== domFingerprint();
}

/**
 * Resolve the pre-action fingerprint from an {@link ActionContext}, accepting
 * either the executor's lazy memoized holder or a legacy plain-string value.
 */
export function resolveBeforeFingerprint(ctx: ActionContext): string {
  const fp = ctx.beforeFingerprint as unknown;
  return typeof fp === "string" ? fp : (fp as LazyFingerprint).get();
}
