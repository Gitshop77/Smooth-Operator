# AGENTS.md

## Project

Open Cowork is a standalone Node.js MCP server. It exposes secure browser
automation over the official Model Context Protocol SDK. There is no browser
extension, service worker, content script, embedded model provider, or local
agent loop in this repository.

The runtime is organized as:

- src/server/main.ts — stdio and Streamable HTTP startup, authentication, and shutdown.
- src/server/mcp.ts — MCP tool, resource, and user-facing prompt registration.
- src/server/runtime.ts — dependency composition and lifecycle ownership.
- src/server/browser/service.ts — Puppeteer/CDP browser operations and tab state.
- src/server/policy.ts — URL, file, capability, and security-mode enforcement.
- src/server/config.ts — validated environment and JSON configuration.
- src/server/research.ts — bounded, untrusted DuckDuckGo result retrieval.
- src/server/errors.ts and logger.ts — safe MCP errors and structured stderr logs.

## Commands

| Command | Purpose |
| --- | --- |
| npm run dev | Watch the native MCP server |
| npm start | Start the server over stdio |
| npm run mcp:http | Start Streamable HTTP |
| npm run typecheck | Run strict TypeScript checks |
| npm run lint | Run ESLint |
| npm test | Run the Vitest suite |
| npm run test:browser:live | Opt-in live browser contract (requires Chrome) |
| npm run test:coverage | Run tests with the coverage gate |
| npm run dead-code | Run the pinned Knip reachability/dependency scan |
| npm run build | Build dist/open-cowork-mcp.mjs |

## Runtime rules

- Keep the MCP boundary thin: request validation and transport belong in mcp.ts
  and main.ts; browser behavior belongs in BrowserService; policy is enforced
  again at the service boundary.
- Do not add model-provider SDKs or an internal planning loop. The connected
  MCP client supplies reasoning and calls explicit tools.
- Treat every page, search result, DOM attribute, cookie value, and browser log
  as untrusted data. Keep outputs bounded and redact secrets.
- HTTP binds to loopback unless remote mode is explicitly enabled with a
  32-character bearer token.
- File uploads and PDF writes must pass allowed-root and realpath checks.
- Page JavaScript evaluation is disabled unless both full security mode and
  OPEN_COWORK_ALLOW_EVAL=true are configured.
- Do not commit dist/ or coverage/; both are generated.

## Verification

Before handing off a change, run npm run lint, npm run typecheck, npm test,
npm run test:coverage, npm run dead-code, and npm run build. Scan for stale
extension/provider/model references with rg and inspect the resulting git diff.
The hosted CI job additionally runs the explicit live-browser contract with a
discovered Chrome executable; local environments without Chrome may skip it.
