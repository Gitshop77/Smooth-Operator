# Task 11 Report: register `browser_solve_challenge` + opt-in CAPTCHA text

## Status
DONE_WITH_CONCERNS (one intentional, documented deviation from the brief — see Deviations)

## What was done
Registered the opt-in CAPTCHA solver (wired in Task 10) as an MCP tool and updated the
CAPTCHA-facing text, touching only `mcp.ts` (4 changes) and `contracts.ts` (1 new schema export),
exactly per the task's surgical constraint.

### 11a. Tool input schema — `src/server/contracts.ts`
Added, immediately after `WaitForHumanRequestSchema` (line 628):
```ts
export const SolveChallengeRequestSchema = z.object({ pageId: BoundedString(200) }).strict();
```
Live-verified schema output: `{ type: object, properties: { pageId: { type: string, minLength: 1, maxLength: 200 } }, required: ["pageId"], additionalProperties: false }`.
`pageId` is required (schema-level) and the object is strict (`additionalProperties: false`),
so unknown keys and a missing `pageId` are both rejected before dispatch.

### 11b. Import + register `browser_solve_challenge` — `src/server/mcp.ts`
- Imported `SolveChallengeRequestSchema` from `./contracts` (after `WaitForHumanRequestSchema`).
- Registered the tool right after `browser_wait_for_human`, mirroring that `registerAction` call:
  - title `Solve a web challenge`, honest opt-in description (capsolver / 2captcha / anticaptcha,
    falls back to HITL, reports `bypassAttempted`).
  - action `"solve_challenge"`. No explicit annotations passed, so it uses the default
    `actionAnnotations("solve_challenge")`.

### 11c. `actionAnnotations` — `src/server/mcp.ts`
`solve_challenge` is explicitly placed in the `BROWSER_MUTATING` group alongside `navigate`
(`case "navigate": case "solve_challenge": return BROWSER_MUTATING;`), rather than relying on the
`default`. Live-verified the registered annotation is exactly
`{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`.

### 11d. MCP_INSTRUCTIONS — `src/server/mcp.ts`
Replaced the "does not solve or bypass" stance line with the opt-in description:
"CAPTCHA handling is opt-in: stealth + human-in-the-loop by default; an optional solver can be
enabled via config. Use browser_challenge to detect, browser_wait_for_human for human takeover,
and browser_solve_challenge only when a solver is configured."

### 11e. Tool descriptions — `src/server/mcp.ts`
- `browser_challenge`: now notes the opt-in solving path (browser_solve_challenge / browser_wait_for_human).
- `browser_wait_for_human`: softened to "Solving is opt-in via browser_solve_challenge; this tool
  performs no solving."

## Verification
- `npm run typecheck` — clean (exit 0).
- Tool count verified 60 → 61 (42 `registerAction` + 19 external `registerTool`).
- Full suite: 408 tests, 4 failures — all expected and pre-announced by the brief:
  - `tests/mcp.test.ts`, `tests/transport-http.test.ts`, `tests/transport-stdio.test.ts`:
    `toHaveLength(60)` now receives 61 (Task 12 fixes).
  - `tests/contract-snapshot.test.ts`: SHA changed `e84f39a3…` → `5161d832…` (Task 14 re-locks).
  - No other regressions.
- verify-package hygiene: new strings contain no forbidden phrases
  (`chrome extension`, `content script`, `model provider`, `service worker`, `embedded
  model/agent`, `native messaging`, `lightpanda`, `internal loop`, `src/extension`).

## Deviations from the brief
1. **`.required()` dropped (zod v4 API change).** The brief's exact code was
   `z.object({ pageId: BoundedString(200).required() }).strict();`, but `BoundedString` returns a
   `ZodString` and zod 4.4.3 removed the `.required()` method (`tsc` error TS2339). `BoundedString(200)`
   is already a required field (no `.optional()`, unlike `PageInput.pageId`), and every existing
   required schema in the file uses bare `BoundedString(N)` (e.g. `SelectorRequestSchema`,
   `PdfRequestSchema`, `UploadRequestSchema`). Dropping `.required()` preserves the brief's intent
   (schema-level required `pageId`) and matches the codebase style. Live-verified `required: ["pageId"]`.
2. **`actionAnnotations` placement.** The brief's prose said "after `case "navigate":` add
   `case "solve_challenge":` to the mutating group", but my first edit accidentally placed it in the
   READ_ONLY group (after `wait_for_human`). Corrected to the MUTATING group with `navigate`, matching
   the task's binding requirement that the annotation be `BROWSER_MUTATING`.

## Notes
- `browser_solve_challenge` is confirmed NOT in `CHALLENGE_BLOCKED_ACTIONS` (Task 10 owns that; this
  task did not touch service.ts).
- Did not modify `tests/mcp.test.ts` or `tests/contract-snapshot.test.ts` (Task 12/14).

## Report file
`.superpowers/sdd/STEALTH-CAPTCHA-PLAN/task-11-report.md`
