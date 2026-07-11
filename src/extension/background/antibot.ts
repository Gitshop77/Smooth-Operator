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
import { detectChallenge, waitForChallengeResolution } from "@/lib/agent/anti-bot";

/**
 * Build the `detectChallenge` + `waitForChallengeResolution` callbacks passed
 * to `runAgentLoop` by `buildLoopDeps`. Each reads the active run's current
 * tab id from RunState and delegates to the corresponding `anti-bot` helper.
 * Both are best-effort — they return `null`/`false` on any error (never throw),
 * which matches the inline behavior that previously lived in `run-helpers.ts`.
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
      try {
        const s = await getRunState();
        if (!s) return null;
        return await detectChallenge(s.currentTabId);
      } catch {
        return null;
      }
    },
    // Poll for the challenge to clear on its own. Wraps
    // `waitForChallengeResolution` from `anti-bot.ts` against the run's
    // current tab id.
    waitForChallengeResolution: async () => {
      try {
        const s = await getRunState();
        if (!s) return false;
        const result = await waitForChallengeResolution(s.currentTabId, {
          timeoutMs: 15_000,
          pollMs: 500,
        });
        return result.resolved;
      } catch {
        return false;
      }
    },
  };
}
