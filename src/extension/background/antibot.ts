/**
 * background/antibot.ts — anti-bot hook factory.
 *
 * The challenge detection / resolution logic lives in `@/lib/agent/anti-bot`.
 * This module assembles the two orchestrator callbacks that wire that logic to
 * the current run's tab (read from chrome.storage RunState via `getRunState`).
 */
import { getRunState } from "./state-store";
import { consumeRecentRateLimit } from "./rate-limit-tracker";
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
 * Resolve the active run's current tab id, or `null` if RunState is missing a
 * valid tab. Both antibot hooks share the identical `getRunState` +
 * `hasValidTab` preamble; this helper keeps them from drifting.
 */
async function getActiveTabId(): Promise<number | null> {
  const s = await getRunState();
  if (!hasValidTab(s)) {
    console.warn("[antibot] RunState missing a valid currentTabId — skipping challenge hook.");
    return null;
  }
  return s.currentTabId;
}

/**
 * Build the `detectChallenge` + `waitForChallengeResolution` callbacks passed
 * to `runAgentLoop` by `buildLoopDeps`. Each reads the active run's current
 * tab id from RunState and delegates to the corresponding `anti-bot` helper.
 *
 * Both hooks are best-effort — they never throw — but they distinguish a
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
      const tabId = await getActiveTabId();
      if (tabId === null) return null;
 // Network-authoritative rate-limit signal (a real 429/503 main-frame
 // response recorded by the webRequest listener). This is the ONLY source
 // for a rate-limit — the DOM detector deliberately refuses to derive it
 // from attacker-settable page content. Checked first so a throttled page is
 // surfaced before the agent burns another step against it.
      if (consumeRecentRateLimit(tabId)) {
        return {
          kind: "rate-limited",
          message: "Server returned HTTP 429/503 (rate limited).",
        };
      }
 // Use `detectChallengeResult` (not the collapsed `detectChallenge`) so the
 // "error" outcome — a failed injection (tab closed, chrome:// URL, CSP, a
 // racing navigation) — is NOT treated as "all clear". We surface it as a
 // distinct, truthy sentinel the orchestrator treats as an unverified page
 // (it pauses/waitForChallengeResolution rather than proceeding blindly).
      const outcome = await detectChallengeResult(tabId);
      if (outcome.status === "challenge") return outcome.info;
      if (outcome.status === "error") {
        console.warn(
          "[antibot] detectChallenge: injection could not be performed for tab " +
            `${tabId} — treating as UNVERIFIED (orchestrator should pause, ` +
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
      const tabId = await getActiveTabId();
      if (tabId === null) return false;
      const result = await waitForChallengeResolution(tabId, {
        timeoutMs: 15_000,
        // Jitter the poll cadence so the anti-bot challenge-resolution poll is
        // not a perfectly regular 500ms timer (a minor automation fingerprint).
        pollMs: 500 + Math.floor(Math.random() * 100),
      });
      return result.resolved;
    },
  };
}
