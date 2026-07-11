# Third-Party Licenses and Attributions

Open Cowork bundles and builds upon several open-source projects. This file
documents the third-party code and data used by the project and their license
terms. The root project itself is distributed under the [MIT License](LICENSE).

## Components

| Project | License | Notes |
|---|---|---|
| **shadcn/ui** | MIT | UI component primitives (copy-in `cockpit/src/components/ui/`). |
| **Radix UI** | MIT | Unstyled, accessible primitives underlying the shadcn/ui components. |
| **@huggingface/transformers** | Apache-2.0 | In-browser ONNX inference runtime used by the Local Vision Assistant. |
| **models.dev** | Live data / CC0-ish catalog | Live model catalog fetched at runtime by the LLM provider layer (no code bundled; data is retrieved and cached). |
| **onnxruntime-web** | MIT | In-browser ONNX inference runtime (WebGPU/CPU) used by the Local Vision Assistant. (package.json declares MIT — the earlier "Apache-2.0" assumption was incorrect; no NOTICE propagation required.) |
| **next** | MIT | Next.js React framework powering the cockpit dashboard (`cockpit/`, dependency). |
| **react** | MIT | UI library used by the cockpit (`cockpit/`, dependency). |
| **react-dom** | MIT | React DOM renderer used by the cockpit (`cockpit/`, dependency). |
| **prisma** | Apache-2.0 | Prisma CLI / schema tooling used by the cockpit (`cockpit/`, dependency). |
| **@prisma/client** | Apache-2.0 | Generated Prisma client used by the cockpit (`cockpit/`, dependency). |
| **socket.io** | MIT | Real-time WebSocket server used by the `cowork-events` mini-service (port 3003, dependency). |
| **socket.io-client** | MIT | Real-time WebSocket client used by the cockpit (`cockpit/` dependency; also a root devDependency). |
| **zod** | MIT | Schema validation library (v4) used across the extension and cockpit. |
| **framer-motion** | MIT | Animation library for the cockpit UI. |
| **next-themes** | MIT | Dark/light theme provider for the cockpit. |
| **lucide-react** | ISC | Icon set used in the cockpit UI. |
| **zustand** | MIT | Client-side state store (`use-cowork-store`) in the cockpit. |
| **@tanstack/react-query** | MIT | Data-fetching/caching layer (`use-cowork-query`) in the cockpit. |
| **class-variance-authority** | Apache-2.0 | Class-variant authoring used by the shadcn/ui components. |
| **clsx** | MIT | Conditional `className` utility (`cn()`). |
| **tailwind-merge** | MIT | Tailwind class-merging utility (`cn()`). |
| **tailwindcss** | MIT | Utility-first CSS framework used to build the cockpit styles (`cockpit/` devDependency). |
| **@tailwindcss/postcss** | MIT | Tailwind v4 PostCSS plugin used to build the cockpit styles (`cockpit/` devDependency). |
| **postcss** | MIT | CSS transformation toolchain used to build the cockpit styles (`cockpit/` devDependency; also a root dependency). |
| **tw-animate-css** | MIT | Tailwind animation utility classes used by the cockpit (`cockpit/` devDependency). |
| **z-ai-web-dev-sdk** | ISC | AI-proxy SDK used by the cowork-events mini-service (port 3003) to generate chat/image completions (license resolved — see "Action required" below). |

## Notes

- **shadcn/ui** components are copied into the repository and modified; their
  MIT license and original copyright notices should be preserved in those files.
- **Radix UI** packages are npm dependencies; their MIT licenses are included in
  `node_modules/` and surfaced by `npm`/`package.json`.
- **@huggingface/transformers** is licensed under Apache-2.0. The Apache-2.0
  license and `NOTICE` file ship with the published package.
- **models.dev** is a community-maintained model catalog. The extension fetches
  it at runtime (live data, not bundled code). Confirm the catalog's current
  usage/attribution terms before redistributing a cached copy.
- **onnxruntime-web** is MIT licensed (confirmed from its published `package.json`),
  not Apache-2.0 — no `NOTICE` file propagation is required.
- **lucide-react** is ISC licensed (confirmed from its published `package.json`).
- **class-variance-authority** is Apache-2.0; its license and `NOTICE` ship with
  the published package in `node_modules/`.
- **next** is MIT licensed (confirmed from its published `package.json`, v16.2.10).
- **react** and **react-dom** are MIT licensed (confirmed from their published
  `package.json`, v19.2.7).
- **prisma** and **@prisma/client** are Apache-2.0 licensed (confirmed from their
  published `package.json`, v6.19.3). Under Apache-2.0 §4(d), if a `NOTICE` file
  is distributed with the upstream source it must be propagated on
  redistribution. The installed `node_modules` copies bundle only a `LICENSE`
  file (no `NOTICE`), so reproduce the Apache-2.0 license text and — if you
  redistribute from a Prisma source tree that includes a `NOTICE` — carry that
  `NOTICE` forward.
- **socket.io** (the `cowork-events` mini-service server) and **socket.io-client**
  (the cockpit client; also a root devDependency) are MIT licensed (confirmed
  from their published `package.json`, v4.8.3).
- **tailwindcss**, **@tailwindcss/postcss**, **postcss**, and **tw-animate-css**
  are MIT licensed (confirmed from their published `package.json`; `postcss` by
  Andrey Sitnik, `tw-animate-css` by Luca Bosin). They are `cockpit/` build-time
  (dev) dependencies but are required to bundle the cockpit's shipped CSS.
- **z-ai-web-dev-sdk** is ISC licensed (confirmed from its published
  `package.json`, version 0.0.18). No separate `LICENSE` file ships inside the
  package, but the `license` field declares ISC.

## Action required

- **Previously omitted runtime/build dependencies**: Resolved. The following
  packages were missing from this file and have now been added to the Components
  table with their licenses confirmed from the installed `node_modules/<pkg>/package.json`:
  `next`, `react`, `react-dom`, `prisma`, `@prisma/client`, `socket.io`,
  `socket.io-client`, `tailwindcss`, `postcss`, `@tailwindcss/postcss`,
  `tw-animate-css`. All resolved locally to a known license (MIT or Apache-2.0);
  none required a "see upstream" fallback.
- **`z-ai-web-dev-sdk`**: Resolved. The package's `package.json` declares an
  **ISC** license (version 0.0.18). A row has been added to the Components table
  above. No separate `LICENSE` file is bundled in the package; if you redistribute
  the package, reproduce the ISC license text from the published package metadata.
  (If a future version changes the declared license, update the table accordingly.)
- **`prisma` / `@prisma/client` NOTICE**: Verify. Both are Apache-2.0. The
  installed packages bundle only `LICENSE` (no `NOTICE`). If you redistribute a
  Prisma source tree that ships a `NOTICE`, propagate it per Apache-2.0 §4(d).
