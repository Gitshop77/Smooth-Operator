# Contributing to Open Cowork

Thanks for your interest in contributing! Open Cowork is an open-source agentic browser-control Chrome extension.

## Getting Started

1. Clone the repo: `git clone https://github.com/Gitshop77/open-cowork-chrome-extension.git`
2. Install dependencies: `npm install` (the `postinstall` hook also installs the `cockpit/` and `mini-services/cowork-events/` sub-packages)
3. Build the extension: `npm run build:extension`
4. Load `chrome-extension/` as an unpacked extension in Chrome
5. Run tests: `npm run test`

## Development Workflow

All commands use npm. For one-command dev (starts extension watch-build + cockpit + events together):

```bash
npm install && npm run dev
```

Individual commands:

- `npm run dev` — Start extension watch-build + cockpit dev server + cowork-events mini-service together (via `concurrently`)
- `npm run dev:ext` — Extension watch-build only (esbuild --watch)
- `npm run dev:cockpit` — Start the Next.js cockpit dev server (port 3000, bound to 127.0.0.1)
- `npm run dev:events` — Start the cowork-events mini-service (port 3003)
- `npm run test` — Run the full Vitest test suite (no dev server required)
- `npm run test:watch` — Run tests in watch mode
- `npm run test:coverage` — Run tests with coverage reporting
- `npm run lint` — Run ESLint on the extension codebase
- `npm run build:extension` — Build the Chrome extension via esbuild
- `npm run build:cockpit` — Build the Next.js cockpit for production
- `npm run build:all` — Build extension + cockpit
- `cd cockpit && npx tsc --noEmit` — Type-check the cockpit
- `cd cockpit && npm run lint` — Lint the cockpit codebase

## Cockpit Development

The `cockpit/` directory contains a Next.js 16 dashboard. It has its own
`package.json`, `tsconfig.json`, and `eslint.config.mjs`. From the repo root,
use `npm run dev:cockpit` to start it. The cockpit talks to the
`mini-services/cowork-events` mini-service over HTTP/WebSocket on port 3003.

The cockpit dashboard is a read-mostly view over persisted data. POST
endpoints exist for creating tabs, workspaces, sessions, workflows, bookmarks,
and pinboards. There are no DELETE endpoints yet.

## Code Style

- TypeScript throughout with strict typing
- shadcn/ui components preferred over custom implementations
- JSDoc-style header comments on every exported function
- See `AGENTS.md` for the full architecture guide

## Pull Requests

1. Fork the repo and create a feature branch
2. Run `npm run lint` and `npm run test` before submitting
3. For cockpit changes, also run `cd cockpit && npx tsc --noEmit`
4. Keep PRs focused — one feature or fix per PR
5. Add tests for new functionality

## Documentation

- **README demo GIF**: A short 10–15-second demo GIF (the agent filling out a
  form, pulling data off a page, etc.) earns its spot near the top of the
  README — it communicates what the project does faster than any paragraph of
  text. Record one with Kap (Mac), ScreenToGif (Windows), or Peek (Linux)
  and commit it under `docs/` (or embed via the GitHub user-attach UI on a
  PR). Keep the file under ~3 MB so the README renders fast.
