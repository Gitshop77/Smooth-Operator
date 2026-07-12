/**
 * background/antibot.ts — anti-bot hook factory extracted from
 * `run-helpers.ts`.
 *
 * The actual challenge detection / resolution logic lives in
 * `@/lib/agent/anti-bot`. This module only assembles the two orchestrator
 * callbacks that wire that logic to the CURRENT run's tab (read from
 * chrome.storage RunState via `getRunState`). It references NO module-local
 * state from `run-helpers.ts` — only external imports + `chrome.*` — so it
 * is safe to isolate. The signatures match `LoopDeps` exactly so the spread
 * into `buildLoopDeps`' return object is behavior-identical.
 */
import { getRunState } from "./state-store";
import {
  detectChallengeResult,
  waitForChallengeResolution,
} from "@/lib/agent/anti-bot";

/** True when the persisted RunState has a usable, finite current tab id. */
function hasValidTab(s: { currentTabId?: unknown; active?: unknown } | null): s is {
  currentTabId: number;
  active: boolean;
} {
  return (
    !!s &&
    typeof s.currentTabId === "number" &&
    Number.isFinite(s.currentTabId) &&
    s.active === true
  );
}

/**
 * Build the `detectChallenge` + `waitForChallengeResolution` callbacks passed
 * to `runAgentLoop` by `buildLoopDeps`. Each reads the active run's current
 * tab id from RunState and delegates to the corresponding `anti-bot` helper.
 *
 * Both hooks are best-effort — they never throw (matching the inline behavior
 * that previously lived in `run-helpers.ts`) — but they distinguish a
 * *failed* detection from a genuine "no challenge" so the orchestrator can
 * pause/retry on an unverified page instead of proceeding blindly.
 */
export function makeAntiBotHooks(): {
  detectChallenge: () => Promise<{ kind: string; message: string } | null>;
  waitForChallengeResolution: () => Promise<boolean>;
} {
  return {
 // Anti-bot challenge detection. The orchestrator calls this before each
 // navigator step; when a challenge is detected we surface it + wait for
 // it to resolve (Cloudflare JS challenges auto-resolve in ~5s; CAPTCHAs
 // need user takeover, which `waitForTakeoverResume` handles in the
 // orchestrator).
    detectChallenge: async () => {
      const s = await getRunState();
      if (!hasValidTab(s)) {
 // A stale / malformed / old-version RunState blob missing `currentTabId`
 // would otherwise produce `undefined` typed as `number` and let a failed
 // `executeScript({ target: { tabId: undefined } })` be silently swallowed
 // as "no challenge" — disabling challenge detection with no signal.
        console.warn(
          "[antibot] detectChallenge: RunState missing a valid `currentTabId` " +
            "(stale or malformed persisted state) — skipping challenge detection.",
        );
        return null;
      }
 // Use `detectChallengeResult` (not the collapsed `detectChallenge`) so the
 // "error" outcome — a failed injection (tab closed, chrome:// URL, CSP, a
 // racing navigation) — is NOT treated as "all clear". We surface it as a
 // distinct, truthy sentinel the orchestrator treats as an unverified page
 // (it pauses/waitForChallengeResolution rather than proceeding blindly).
      const outcome = await detectChallengeResult(s.currentTabId);
      if (outcome.status === "challenge") return outcome.info;
      if (outcome.status === "error") {
        console.warn(
          "[antibot] detectChallenge: injection could not be performed for tab " +
            `${s.currentTabId} — treating as UNVERIFIED (orchestrator should pause, ` +
            "not proceed onto a possibly-injected page).",
          outcome.error,
        );
        return {
          kind: "detection-error",
          message:
            "Challenge detection could not be verified (injection failed) — pausing " +
            "rather than proceeding onto a possibly-injected page.",
        };
      }
      return null;
    },
 // Poll for the challenge to clear on its own. Wraps
 // `waitForChallengeResolution` from `anti-bot.ts` against the run's
 // current tab id. `anti-bot.ts` already treats an injection failure during
 // polling conservatively (it does NOT report the challenge as resolved), so
 // a transient detection failure surfaces as "still present" rather than
 // "cleared".
    waitForChallengeResolution: async () => {
      const s = await getRunState();
      if (!hasValidTab(s)) {
        console.warn(
          "[antibot] waitForChallengeResolution: RunState missing a valid " +
            "`currentTabId` — cannot wait for challenge resolution.",
        );
        return false;
      }
      const result = await waitForChallengeResolution(s.currentTabId, {
        timeoutMs: 15_000,
        pollMs: 500,
      });
      return result.resolved;
    },
  };
}
