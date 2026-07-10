/**
 * `search` action handler — resolve the engine URL, enforce the domain
 * allow/blocklist, then navigate the current tab to the search results.
 *
 * Same-tab navigation uses `location.href` (the content script can do this).
 * The domain check uses `getDomainConfig()`, which reads the
 * `__openCoworkDomainConfig` global the SW ships with each EXECUTE_ACTIONS
 * message — without it, the user's allow/blocklist would be silently
 * bypassed for `search`.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { SEARCH_ENGINE_URLS } from "../constants";
import { checkUrlAllowedWithDomainConfig } from "../helpers/domain-config";
import type { ActionContext } from "./types";

export async function handleSearch(
  _ctx: ActionContext,
  action: Extract<Action, { type: "search" }>,
): Promise<ActionResult> {
  const engine = action.engine;
  const baseUrl = SEARCH_ENGINE_URLS[engine] || SEARCH_ENGINE_URLS.duckduckgo;
  const searchUrl = baseUrl + encodeURIComponent(action.query);
  // Enforce the domain policy — same gate as `navigate`. Without this,
  // a user with a blocklist covering search-engine domains would have that
  // policy silently bypassed for the `search` action.
  const urlCheck = checkUrlAllowedWithDomainConfig(searchUrl);
  if (!urlCheck.allowed) {
    return {
      action,
      success: false,
      message: `BLOCKED: ${urlCheck.reason} (${searchUrl})`,
    };
  }
  // Navigate the current tab to the search URL. The content script is
  // destroyed on navigation; the orchestrator recovers on the next step.
  location.href = searchUrl;
  return { action, success: true, message: `Searching "${action.query}" on ${engine}`, pageChanged: true };
}
