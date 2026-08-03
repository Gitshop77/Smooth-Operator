import type { BrowserState } from "../../types";
import type { LoaderRunResult } from "../../dom/navigation/url-loaders";
import { domFingerprint } from "../helpers";

export interface ActionContext {
  state: BrowserState;
  beforeUrl: string;
  beforeFingerprint: string;
  signal?: AbortSignal;
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

export function hasPageChanged(ctx: ActionContext): boolean {
  return (
    location.href !== ctx.beforeUrl ||
    domFingerprint() !== ctx.beforeFingerprint
  );
}
