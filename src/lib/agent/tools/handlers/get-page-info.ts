/** `get_page_info` action handler — read page-level metadata as a JSON payload. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/**
 * Snapshot of the current page: URL, title, readiness, viewport dimensions,
 * full-document dimensions, and the current scroll position — serialized as
 * the extractedContent. Pure read, no failure modes.
 */
export function handleGetPageInfo(
  _ctx: ActionContext,
  action: Extract<Action, { type: "get_page_info" }>,
): ActionResult {
  const payload = {
    url: window.location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    scroll: { x: window.scrollX, y: window.scrollY },
  };
  const extractedContent = JSON.stringify(payload);
  return {
    action,
    success: true,
    message: `Page info: "${payload.title}" — ${payload.url} (state: ${payload.readyState})`,
    extractedContent,
  };
}
