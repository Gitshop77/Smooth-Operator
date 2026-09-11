# Contributing

Users: start with [README.md](../README.md). Agents: [AGENTS.md](../AGENTS.md).

## Baseline

Node.js 22.23.2 and npm 12.0.2. Package name is `smooth-operator-mcp` only.
Bin is `smooth-operator`.

```sh
npm ci
npm run verify
```

`npm run verify` is lint, typecheck, coverage tests, knip, and package smoke
(build + pack checks). `npm test` and `npm run test:coverage` exclude
`tests/browser-live.test.ts`. Live Chrome is only:

```sh
npm run test:browser:live
```

Do not fold that gated suite into verify. Do not commit `dist/` or `coverage/`.

## Public surface

Keep every published capability reachable through a canonical tool plus
arguments. `src/server/catalog.ts` and `tests/contract-snapshot.test.ts` lock
`tools/list` (57 one-job tools; compatibility aliases are not listed). Adding a tool
requires a catalog entry, a schema, a handler, and a protocol call in
`tests/mcp.test.ts`.

## Product law

This is a browser MCP server. The harness reasons. No model SDK, planner loop,
packaged browser add-on, or arbitrary CDP/host-code tool. Fail closed. Bound and redact
untrusted page data. One profile lease.

## Layout

See [docs/architecture.md](architecture.md). Tests live in `tests/`. Installer
golden behavior is in `tests/installer.test.ts` and `tests/installer-wizard.test.ts`.
