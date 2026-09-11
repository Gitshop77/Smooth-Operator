# Architecture

SmoothOperator is a standalone Node.js MCP browser server. The harness reasons.
The server validates, enforces policy twice, drives one Chromium profile, and
returns a bounded result envelope. There is no model SDK, planner loop,
packaged browser add-on, or arbitrary CDP/host-code tool.

```text
MCP client
  ├─ stdio, or Streamable HTTP (`/mcp`) + sibling `/healthz`
  └─ MCP registry (one catalog → tools, resources, prompts)
       └─ ServerRuntime
            ├─ SecurityPolicy   (edge + service, same implementation)
            ├─ BrowserService   (exclusive queue + Puppeteer/CDP)
            ├─ ResearchService  (bounded DuckDuckGo HTML)
            └─ Logger           (JSON stderr, redacted)
```

## Module ownership

| Module | Owns |
|---|---|
| `src/server/main.ts` | CLI dispatch: `server`, `install`, `doctor` |
| `src/server/cli.ts` | Help, version, doctor diagnostics |
| `src/server/http.ts` | Streamable HTTP, Host/Origin/bearer, `healthz`, shutdown bounds |
| `src/server/catalog.ts` | Locked 57-tool names, retired-name map, resources, prompts, instructions |
| `src/server/mcp.ts` | Registration and dispatch from the catalog |
| `src/server/envelope.ts` | One result envelope: bound, redact, explicit truncation |
| `src/server/contracts.ts` | Zod schemas shared by tools and `browser_batch` |
| `src/server/runtime.ts` | Lifecycle, exclusive profile lease, health |
| `src/server/policy.ts` | URL/DNS/file/eval gates used at the MCP edge and again at the service |
| `src/server/config.ts` | Env + JSON config, chmod-600 reads |
| `src/server/browser/service.ts` | Browser facade: execute, snapshot, tabs, doctor, four modes |
| `src/server/browser/queue.ts` | Exclusive/read lane, absolute queue deadline, abort recovery |
| `src/server/browser/challenges.ts` | Pure evidence → classification |
| `src/server/research.ts` | Bounded search, `redirect: "error"`, anti-bot reported not bypassed |
| `src/server/installer.ts` / `installer-wizard.ts` | Harness install, three-question wizard, atomic config IO |
| `src/server/errors.ts` / `logger.ts` / `security.ts` | AppError + recovery, JSON logs, untrusted wrappers |

## One of each

- **One catalog** feeds `tools/list` and handlers (`catalog.ts`).
- **One envelope** serializes success and error (`envelope.ts`). Text fallback equals structured content.
- **One policy implementation** (`SecurityPolicy`) is applied at the MCP edge (navigate/eval) and again inside `BrowserService` / research.
- **One exclusive profile lease** (`runtime.ts` lock file) plus one in-process operation queue (`browser/queue.ts`). A timed-out operation recovers the old lifecycle before the next waiter is released.

## Browser modes

| Mode | Process | Profile |
|---|---|---|
| `managed` | Launch or reattach via `DevToolsActivePort` | `${DATA_DIR}/browser` |
| `connect` | Attach to configured `browserURL` / `wsEndpoint` | Wizard Personal Chrome uses `personal-chrome`; `chrome://inspect` daily-profile attach is advanced opt-in (`mcp-server.md`) |
| `launch` | Launch configured executable | Configured `userDataDir` |
| `disabled` | None | Browser tools fail `BROWSER_DISABLED`; policy still runs |

## Transports

Stdio is the default. HTTP binds loopback unless `SMOOTH_OPERATOR_ALLOW_REMOTE_HTTP=true` with a 32-character token. `GET/HEAD <path>/healthz` uses the same Host, Origin, and bearer checks as `/mcp` and returns `{ status, ready, server, transport, checks }` without page data.

## Verify

`npm run verify` is lint, typecheck, coverage tests, knip, and package smoke
(which builds). Coverage and `npm test` pass `--exclude tests/browser-live.test.ts`.
Live Chrome is only `npm run test:browser:live` (explicit `vitest run tests/browser-live.test.ts`) and is not inside verify.
