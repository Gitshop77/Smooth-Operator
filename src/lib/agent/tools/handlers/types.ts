import type { BrowserState } from "../../types";
import { domFingerprint } from "../helpers";

export interface ActionContext {
  state: BrowserState;
  beforeUrl: string;
  beforeFingerprint: string;
  signal?: AbortSignal;
}

export function isExtensionContext(): boolean {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

export function hasPageChanged(ctx: ActionContext): boolean {
  return (
    location.href !== ctx.beforeUrl ||
    domFingerprint() !== ctx.beforeFingerprint
  );
}
