/**
 * esbuild config — bundles the Chrome extension from TypeScript.
 *
 * Single source of truth in `src/lib/agent/*` and `src/extension/*` is bundled
 * into `chrome-extension/` for loading as an unpacked extension. Static assets
 * (manifest, HTML, CSS, icons) are copied verbatim.
 *
 * Usage:
 * npm run build:extension # one-shot build
 * npm run build:extension -- --watch # rebuild on change
 */

import { build, context, type BuildOptions, type Plugin } from "esbuild";
import { copyFile, mkdir, rm, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { assertOnlyEnZodLocales, lintManifestPermissions, stripConsoleDebug } from "./build-utils";

const watch = process.argv.includes("--watch");
const OUT = path.resolve("chrome-extension");
const SRC = path.resolve("src/extension");
// Hoisted: `path.resolve("src/lib")` is constant for the whole build, so it is
// computed once rather than on every source file the plugin loads.
const LIB_SRC = path.resolve("src/lib");

/**
 * PERF-1: zod locales stub plugin.
 *
 * `node_modules/zod/v4/locales/index.js` is a barrel that re-exports ALL 50+
 * locale files (~616 KB). esbuild can't tree-shake the dynamic lookup pattern
 * zod uses, so every locale file ends up in every bundle. We only ever format
 * validation errors against the `en` locale at runtime — enforced at build time
 * by `assertOnlyEnZodLocales()` below — so the other 49+ locales are dead
 * weight.
 *
 * This plugin intercepts any import of the locales barrel coming from inside
 * `node_modules/zod/` and redirects it to a one-line stub that exports ONLY
 * `en`. Because zod is reachable from multiple entry points (background,
 * content, sidepanel, options), the stub is registered on ALL entries via
 * `sharedConfig` — not just the MV3 service worker. If a non-`en` locale is
 * ever requested, the stub resolves to `undefined`; the build-time guard fails
 * closed so the latent risk never reaches a shipped bundle. Saves ~600 KB on
 * every bundle.
 */
const zodLocalesStubPlugin: Plugin = {
  name: "zod-locales-stub",
  setup(b) {
    b.onResolve({ filter: /locales\/index/ }, (args) => {
 // Only intercept imports originating from inside the zod package —
 // avoids clobbering an unrelated `locales/index.js` somewhere else.
 // esbuild always reports `importer` in POSIX form (even on Windows), so
 // match with "/" rather than path.sep, which would be "\" on Windows and
 // silently no-op the guard there.
      if (
        args.importer &&
        args.importer.includes("/node_modules/zod/")
      ) {
        return { path: path.resolve(SRC, "zod-locales-stub.js") };
      }
      return undefined;
    });
  },
};

/**
 * PROD-1: strip first-party `console.debug`/`console.log` calls from the
 * production bundle. The bundle hard-pins `process.env.NODE_ENV="production"`
 * and esbuild does not tree-shake these, so they would otherwise run
 * unconditionally in the shipped extension and leak internal state into the
 * devtools console. Only first-party source (`src/extension`, `src/lib`) is
 * rewritten; `node_modules` is left untouched. `warn`/`error`/`info` are
 * preserved intentionally so real failures stay visible.
 *
 * `console.debug(x)` / `console.log(x)` become `void (x)` — the argument
 * expression still evaluates but its result is discarded, so call-site
 * behavior (other than the dropped log) is unchanged. A zero-argument call
 * `console.log()` becomes `void 0;` (a valid statement) rather than the
 * invalid `void ()` a naive rewrite would produce. A call whose first argument
 * is a spread (e.g. `console.log(...args)`) is left untouched: rewriting it to
 * `void (...args)` would be a SyntaxError, so the original call is preserved.
 *
 * The match is anchored with a negative lookbehind `(?<![\w.$])` so a member
 * expression like `window.console.log("x")` is NOT rewritten to
 * `window.void ("x")` (which would throw a `TypeError` at runtime), and
 * `myconsole.log(...)` is likewise left alone.
 *
 * KNOWN LIMITATIONS (documented, not silently swallowed): this is a textual
 * transform, not a full AST walk. Two cases are intentionally NOT rewritten —
 * both because doing so correctly requires scope-aware resolution of the
 * `console` binding, which a regex cannot do safely:
 * 1. A locally-shadowed `console` (e.g. `function f(console) { console.log() }`)
 * is still rewritten. A shadowed binding is extremely rare in first-party
 * source; if it ever appears, the log call is dropped (no side effects are
 * lost in practice).
 * 2. `console.log` passed as a *callback* or via an alias
 * (`arr.forEach(console.log)`, `const fn = console.log; fn("x")`) is not
 * rewritten and the log survives into the bundle. This is the lesser evil
 * versus a dangerous AST rewrite that could corrupt unrelated identifiers.
 * String literals and comments ARE now exempt: the rewrite walks the source
 * tracking string/comment state (see `stripConsoleDebug`), so a `console.log(`
 * that appears inside a string literal (e.g. `const s = "console.log(x)"`) or a
 * `// console.log(x)` comment is left intact. The remaining trade-offs are the
 * two scope cases above; closing them would require scope-aware binding
 * resolution, which is intentionally not done to avoid corrupting unrelated
 * identifiers.
 *
 * This plugin is only attached in production builds (see `sharedConfig`); dev
 * (`--watch`) builds keep the logs.
 */

const stripConsoleDebugPlugin: Plugin = {
  name: "strip-console-debug",
  setup(b) {
    b.onLoad({ filter: /\.(ts|tsx|js|jsx|mjs)$/ }, async (args) => {
      const abs = path.resolve(args.path);
      const inSource = abs.startsWith(SRC) || abs.startsWith(LIB_SRC);
      if (!inSource) return undefined;
      const original = await readFile(args.path, "utf8");
      const contents = stripConsoleDebug(original);
      const loader = args.path.endsWith(".tsx")
        ? "tsx"
        : args.path.endsWith(".ts")
        ? "ts"
        : args.path.endsWith(".jsx")
        ? "jsx"
        : "js";
      return { contents, loader };
    });
  },
};

/** Shared esbuild options for all entry points. */
// Production-only transforms (NODE_ENV pin + console-strip) are gated on
// `!watch` so dev (`--watch`) builds keep `console.debug`/`console.log` and
// any `process.env.NODE_ENV !== 'production'` dev branch intact — see PROD-1
// and DEV-1. The zod-locales stub applies in both modes (it only affects
// bundle size/correctness, never logging).
const isProd = !watch;
const sharedConfig: BuildOptions = {
  bundle: true,
  target: "chrome116",
  platform: "browser",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  define: isProd ? { "process.env.NODE_ENV": '"production"' } : {},
  plugins: isProd
    ? [zodLocalesStubPlugin, stripConsoleDebugPlugin]
    : [zodLocalesStubPlugin],
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
 * PERF-1 robustness: fail closed if the zod-locales stub file the redirect
 * plugin depends on is missing. Without it, esbuild fails later with a cryptic
 * "could not resolve zod-locales-stub.js" error unrelated to the real cause.
 */
function assertZodLocalesStub(): void {
  const stub = path.resolve(SRC, "zod-locales-stub.js");
  if (!existsSync(stub)) {
    throw new Error(
      `[zod-locales-stub] missing stub at ${stub} — the zod-locale strip plugin requires it`,
    );
  }
}



/**
 * LIC-1: convey third-party license / attribution text WITH the distributed
 * extension bundle. The Local Vision Assistant bundles `@huggingface/transformers`
 * (Apache-2.0) and `onnxruntime-web` (MIT) into the shipped MV3 extension.
 * Apache-2.0 (S)4(a)-(c) requires the Apache License text (and any upstream
 * NOTICE) to travel with the redistribution; MIT requires reproduction of the
 * copyright/permission notice.
 *
 * We copy the full Apache-2.0 text shipped inside the transformers package
 * (best-effort). `onnxruntime-web` ships no `LICENSE` file in its package, so
 * its MIT copyright + permission notice is reproduced inline below and written
 * to `LICENSE-MIT` in the shipped bundle.
 *
 * Apache-2.0 (S)4(d) additionally requires that any NOTICE distributed with the
 * work travel with every redistribution. Since `buildAll()` wipes and recreates
 * the whole `chrome-extension/` output directory on every build, the NOTICE is
 * (re)written here inline rather than left as a static tracked file — otherwise
 * each build would silently delete it, leaving the shipped bundle out of
 * Apache-2.0 compliance and the working tree perpetually dirty.
 *
 * Note: referencing the third-party license text from the Options/About page
 * and `manifest.json` is tracked separately, outside this build file.
 */
async function emitThirdPartyLicenses(): Promise<void> {
  const targets: Array<[string, string]> = [];
 // The project's own MIT LICENSE (the Options/About page claims the extension
 // is MIT-licensed, so its own license text must travel with the bundle).
  const ownLicense = path.resolve("LICENSE");
  if (existsSync(ownLicense)) targets.push([ownLicense, "LICENSE"]);
 // Full Apache-2.0 text from the transformers package (best-effort).
  const apache = path.resolve("node_modules/@huggingface/transformers/LICENSE");
  if (existsSync(apache)) targets.push([apache, "LICENSE-APACHE"]);
 // MIT notice for `onnxruntime-web` (ships no LICENSE file in its package).
  const ONX_MIT = [
    "MIT License",
    "",
    "Copyright (c) Microsoft Corporation.",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "of this software and associated documentation files (the \"Software\"), to deal",
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
    "",
  ].join("\n");
  for (const [src, out] of targets) {
    if (existsSync(src)) {
      await copyFile(src, path.join(OUT, out));
    } else {
      console.warn(`[licenses] skipping missing license file: ${src}`);
    }
  }
  await writeFile(path.join(OUT, "LICENSE-MIT"), ONX_MIT, "utf8");
 // Apache-2.0 §4(d): ship the NOTICE describing the bundled transformers.js
 // dependency. Written inline (not copied from a tracked source file) because
 // buildAll() clears the OUT dir every build — a copy-from-OUT source would be
 // deleted before this runs.
  const NOTICE = [
    "This project bundles @huggingface/transformers (transformers.js), which is",
    "licensed under the Apache License, Version 2.0.",
    "",
    "  Copyright The HuggingFace Team and contributors.",
    "",
    "The full Apache-2.0 license text is available at:",
    "  https://www.apache.org/licenses/LICENSE-2.0",
    "",
    "Including this dependency does not change the project's own MIT license",
    "(see LICENSE in this directory).",
    "",
  ].join("\n");
  await writeFile(path.join(OUT, "NOTICE"), NOTICE, "utf8");
}

/**
 * Copy static assets (manifest, HTML, CSS, icons) from src to the output dir.
 * Skips files that don't exist (so removing an asset doesn't break the build).
 */
async function copyStatic(): Promise<void> {
  lintManifestPermissions();
  for (const f of STATIC_FILES) {
    const src = path.join(SRC, f);
    if (existsSync(src)) await copyFile(src, path.join(OUT, f));
  }
  await mkdir(path.join(OUT, "icons"), { recursive: true });
  const iconSrc = path.join(SRC, "icons", "icon.png");
  if (existsSync(iconSrc)) await copyFile(iconSrc, path.join(OUT, "icons", "icon.png"));
 // Wire per-size icon PNGs referenced by both manifest files. The manifest
 // uses distinct assets per size (icon-16/32/48/128.png); copy each so a
 // build does not leave dangling icon references in the loaded extension.
  for (const size of ["16", "32", "48", "128"]) {
    const p = path.join(SRC, "icons", `icon-${size}.png`);
    if (existsSync(p)) await copyFile(p, path.join(OUT, "icons", `icon-${size}.png`));
  }
 // Ship third-party license/attribution text alongside the bundle (LIC-1).
  await emitThirdPartyLicenses();
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
  await assertOnlyEnZodLocales();
  assertZodLocalesStub();
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
  await assertOnlyEnZodLocales();
  assertZodLocalesStub();
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
  try {
    if (watch) {
      await watchMode();
    } else {
      await buildAll();
    }
  } catch (err) {
    console.error("Extension build failed:", err);
    process.exit(1);
  }
})();
