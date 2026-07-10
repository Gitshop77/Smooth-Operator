/**
 * esbuild config — bundles the Chrome extension from TypeScript.
 *
 * Single source of truth in `src/lib/agent/*` and `src/extension/*` is bundled
 * into `chrome-extension/` for loading as an unpacked extension. Static assets
 * (manifest, HTML, CSS, icons) are copied verbatim.
 *
 * Usage:
 *   npm run build:extension           # one-shot build
 *   npm run build:extension -- --watch # rebuild on change
 */

import { build, context, type BuildOptions, type Plugin } from "esbuild";
import { copyFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const watch = process.argv.includes("--watch");
const OUT = path.resolve("chrome-extension");
const SRC = path.resolve("src/extension");

/**
 * PERF-1: zod locales stub plugin.
 *
 * `node_modules/zod/v4/locales/index.js` is a barrel that re-exports ALL 50+
 * locale files (~616 KB). esbuild can't tree-shake the dynamic lookup pattern
 * zod uses, so every locale file ends up in every bundle. The MV3 service
 * worker only ever resolves errors against the `en` locale at runtime, so the
 * other 49+ locales are pure dead weight.
 *
 * This plugin intercepts any import of the locales barrel coming from inside
 * `node_modules/zod/` and redirects it to a one-line stub that exports ONLY
 * `en`. Saves ~600 KB on every bundle (background, content, options, sidepanel).
 */
const zodLocalesStubPlugin: Plugin = {
  name: "zod-locales-stub",
  setup(b) {
    b.onResolve({ filter: /locales\/index/ }, (args) => {
      // Only intercept imports originating from inside the zod package —
      // avoids clobbering an unrelated `locales/index.js` somewhere else.
      if (
        args.importer &&
        args.importer.includes(path.sep + "node_modules" + path.sep + "zod" + path.sep)
      ) {
        return { path: path.resolve(SRC, "zod-locales-stub.js") };
      }
      return undefined;
    });
  },
};

/** Shared esbuild options for all entry points. */
const sharedConfig: BuildOptions = {
  bundle: true,
  target: "chrome116",
  platform: "browser",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [zodLocalesStubPlugin],
};

/**
 * PERF-1: background.js is loaded as an ES module (the manifest declares
 * `"background": { "service_worker": "background.js", "type": "module" }`),
 * so we can use `format: "esm"` + `splitting: true`. This lets esbuild emit
 * the dynamically-imported `await import("../vision-assistant")` call in
 * `agent-bridge.ts` as a SEPARATE chunk file — the 2.6 MB vision stack
 * (`@huggingface/transformers` + `onnxruntime-web`) only loads when the user
 * actually enables Local Vision, instead of being parsed on every service
 * worker cold start.
 *
 * Why not `external: ["@huggingface/transformers", "onnxruntime-web"]`?
 * Marking these packages external tells esbuild NOT to bundle them — the
 * bundle would then contain runtime `import("onnxruntime-web")` calls. But
 * the extension does NOT ship `node_modules/`, so the bare specifier would
 * fail to resolve at runtime (no import map, no node resolution). ESM
 * code-splitting achieves the same SW-startup win without breaking vision:
 * the heavy deps live in a lazy-loaded chunk that resolves via relative path.
 *
 * Result: background.js drops from 3.9 MB (single IIFE) → ~10 KB + ~600 KB
 * of small shared chunks loaded eagerly. The 2.6 MB vision chunk loads only
 * when vision is enabled.
 */
const backgroundConfig: BuildOptions = {
  ...sharedConfig,
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  // `entryNames` preserves the output filename as `background.js` (no hash)
  // so the manifest's `"service_worker": "background.js"` reference stays
  // valid. Chunk files get hashed names via `chunkNames`.
  entryNames: "[name]",
};

/**
 * IIFE config for entries that MUST be classic scripts (loaded via
 * `<script src>` without `type="module"`, or injected as content scripts
 * via `chrome.scripting.executeScript` which requires a classic script for
 * the `.js` extension).
 */
const iifeConfig: BuildOptions = {
  ...sharedConfig,
  format: "iife",
};

/** Static files copied from `src/extension/` to `chrome-extension/`. */
const STATIC_FILES = [
  "manifest.json",
  "sidepanel.html",
  "sidepanel.css",
  "options.html",
  "options.css",
] as const;

/** TypeScript entry points + their bundled output filenames. */
const ENTRIES = [
  { entry: "background.ts", out: "background.js", config: backgroundConfig },
  { entry: "content.ts", out: "content.js", config: iifeConfig },
  { entry: "sidepanel.ts", out: "sidepanel.js", config: iifeConfig },
  { entry: "options.ts", out: "options.js", config: iifeConfig },
] as const;

/**
 * Copy static assets (manifest, HTML, CSS, icons) from src to the output dir.
 * Skips files that don't exist (so removing an asset doesn't break the build).
 */
async function copyStatic(): Promise<void> {
  for (const f of STATIC_FILES) {
    const src = path.join(SRC, f);
    if (existsSync(src)) await copyFile(src, path.join(OUT, f));
  }
  await mkdir(path.join(OUT, "icons"), { recursive: true });
  const iconSrc = path.join(SRC, "icons", "icon.png");
  if (existsSync(iconSrc)) await copyFile(iconSrc, path.join(OUT, "icons", "icon.png"));
}

/**
 * One-shot build: clean OUT, copy static assets, bundle every entry point in
 * parallel. Each entry is bundled in its own esbuild invocation so the IIFE
 * entries (content/sidepanel/options) don't share chunks with the ESM entry
 * (background) — keeps the chunk graph clean and avoids format-mixing issues.
 *
 * The ESM entry (background) uses `outdir` + `entryNames: "[name]"` because
 * esbuild requires `outdir` (not `outfile`) when `splitting: true` is set.
 * The IIFE entries use `outfile` (single-file output, no chunks).
 */
async function buildAll(): Promise<void> {
  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await copyStatic();
  const builds = ENTRIES.map((e) => {
    const isEsm = e.config.format === "esm";
    return build({
      ...e.config,
      entryPoints: [path.join(SRC, e.entry)],
      // ESM with splitting requires `outdir`; IIFE entries use `outfile`.
      ...(isEsm
        ? { outdir: OUT }
        : { outfile: path.join(OUT, e.out) }),
    });
  });
  await Promise.all(builds);
  console.log("✓ Extension built to chrome-extension/");
}

/**
 * Watch mode: rebuild entry points on change. Static assets are copied once
 * at start (use `npm run build:extension` after editing static files).
 *
 * Each entry gets its own esbuild context (and thus its own chunk namespace)
 * to avoid the format-mixing issues that arise when a single context bundles
 * both ESM and IIFE entries.
 */
async function watchMode(): Promise<void> {
  const ctxs = await Promise.all(
    ENTRIES.map((e) => {
      const isEsm = e.config.format === "esm";
      return context({
        ...e.config,
        entryPoints: [path.join(SRC, e.entry)],
        ...(isEsm
          ? { outdir: OUT }
          : { outfile: path.join(OUT, e.out) }),
      });
    })
  );
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("👀 Watching src/extension/ for changes…");
  await copyStatic();
}

// Wrap in an async IIFE so top-level await works with both Bun (native)
// and Node/tsx (which doesn't support top-level await in CJS).
void (async () => {
  if (watch) {
    await watchMode();
  } else {
    await buildAll();
  }
})();
