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

## Action required

- **`z-ai-web-dev-sdk`**: This project uses the `z-ai-web-dev-sdk` for AI-proxy
  usage. Its license terms were not confirmed at the time of writing. **Please
  verify and confirm the `z-ai-web-dev-sdk` license terms** and add them here
  once known.
