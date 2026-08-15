# Wave 2 — AUD-3 background

Scope: all 45 TypeScript files under `src/extension/background/` (including `lightpanda/`), cross-checked
against the dependent `src/lib/agent` code (`executor.ts`, `script-runner.ts`, `loop/messages-utils.ts`,
`modes.ts`, `api-key-storage.ts`) and the targeted tests (`download-capture.test.ts`,
`list-downloads-action.test.ts`, `vision-cache-freshness.test.ts`, `tab-manager-handle-tab-action.test.ts`,
`tab-manager-refcount.test.ts`, `run-event-service.test.ts`, `pause-resume.test.ts`).
Read-only audit; no code was changed.

Findings are verified at the cited source lines and ordered by severity.

- [I] `message-routing.ts:74,122` — the download capture ring (`capturedDownloads`, bounded to 20 records,
  filenames/URLs sanitized at capture time) is never reset between runs: `clearCapturedDownloads()` has zero
  callers anywhere in `src/` (grep-verified; only the tests call it). The top-level
  `chrome.downloads.onChanged` listener (`:126-130`) records EVERY completed download in the browser — not
  just agent-initiated ones — and `list_downloads` (`:202`, executor branch `executor.ts:438-478`) serves
  them to the agent under the message "no downloads captured in this session" (`executor.ts:468`) that is
  factually wrong across back-to-back runs and while the SW stays alive: prior-run and unrelated manual
  user downloads (filenames, sizes, mimes, sanitized URLs) leak into the next run's agent context. The
  executor's own message "no downloads captured in this session" makes the cross-run exposure
  misleading as well. Gated only by a run token + one-time effect capability.
- [M] `tab-action-service.ts:388` — `get_storage` (`area.get(null)`) dumps the ENTIRE session+local storage
  into `result.data` unredacted: the raw provider API key (`STORAGE_KEYS.apiKey` in `chrome.storage.session`,
  `api-key-storage.ts:35`), the `open_cowork_secrets` vault, `webhookUrl`, run state, and the last snapshot.
  It is ungated in EVERY mode (`modes.ts` `UNGATED_ACTION_TYPES`, "safe in every mode" — the mode matrix
  treats storage reads as harmless). The LLM-visible seams only render `message`/`extractedContent`
  (`messages-utils.ts:117-121`, `action-queue.ts:246-249`) with exact-value redaction (live cache primed
  with the key + vault secrets), so the LLM cannot directly read the key today — but `run_script`
  surfaces `result.data` into `envelope.step_results` → `extractedContent` (`script-runner.ts:154`), the
  raw dump crosses the content-script boundary to any TAB_ACTION caller, and every future consumer of
  `result.data` inherits the exposure. This is the mirror of the wave-2-root API-key finding: the key is
  both recoverable via the snapshot AND dumpable on demand by the agent in restricted mode.
- [M] `run-helpers.ts:363,505` + `run-helpers-utils.ts:74` — `isVisionCacheFresh` and the detect path's
  fingerprint refresh call `getPageSnapshot(tabId)` → `sendMessageWithTimeout` with the default 20s
  timeout and NO AbortSignal, on the run's per-step path (`extractStateForRun` adaptive branch `:505`,
  `handleDetectVisualRequest` `:363`, click revalidation `message-handlers.ts:317`). A user STOP during a
  stale-cache step is not observed until the content-script round trip completes or times out — up to
  ~20s of non-abortable latency per occurrence, worst-case compounding on a wedged page.
- [M] `run-helpers.ts:946` (`cleanupRun`) + `run-event-service.ts:67-73` — the final
  `{type:"info", message:"Run finished."}` event is ALWAYS dropped: `emit()` rejects events once
  `this.finished || controller.isTerminal`, and `cleanupRun` sends it after the finally block already
  ran `terminalize`/`markFinished`. Dead code — the panel never receives the terminal "Run finished."
  notification (it still gets `done`/`error`/`cancelled`, so this is cosmetic, but the event + its
  test coverage describe behavior that cannot fire).
- [M] `message-handlers.ts:264-273` + `agent-bridge-utils.ts:92-97` — `markDownloadConsentConsumed()` is
  called right after `chrome.downloads.download()` RESOLVES — i.e. at download initiation — while its own
  docstring says "Call this only after a download has actually succeeded." A download that is initiated
  (Save As accepted) but then fails mid-transfer (interrupted, disk error) consumes the one-time
  full_agentic consent reservation; the failure path only releases the reservation when `download()`
  itself rejects (`:271`). A subsequent download in the same run then silently skips the `saveAs` gate
  the user never actually completed.

No [C] findings in this layer. The security-critical boundaries reviewed were verified sound: TAB_ACTION
run-token + one-time effect-capability gating incl. `list_downloads` (dedicated executor branch
`executor.ts:438`, capability replay rejection), the mode matrix (input ungated / confirmRequired /
denied / restricted-mode locks), download sanitization (`sanitizeDownloadName`/`sanitizeDownloadUrl`,
`download-name.ts`), CDP debugger refcount + command timeouts (`tab-manager-utils.ts:84-173`),
content-script messaging timeouts + abort propagation (`sendMessageWithTimeout`), the sender-id gate on
the runtime listener (`message-routing.ts:135`), RESUME pause-flag clearing (`message-routing.ts:235`),
the takeover/warm-hold and snapshot-coalescing durability, close_tab's `currentTabId: 0` sentinel,
`onAdmitted` post-admission failure surfacing, and the Lightpanda native-host client's bounded stream,
correlated ids, and abort/cancel propagation.