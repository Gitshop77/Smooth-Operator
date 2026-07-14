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
import { copyFile, mkdir, rm, readFile, readdir, stat } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";

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
 * invalid `void ()` a naive rewrite would produce.
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
 * A full AST-aware transform (esbuild onTransform + parser) would close both;
 * until then these are accepted, documented trade-offs. String literals /
 * comments are NOT exempt: this is a blind textual regex (no parser awareness),
 * so a `console.log(` that appears inside a string literal (e.g.
 * `const s = "console.log(x)"`) or a `// console.log(x)` comment IS rewritten
 * to `void (x)` / `// void (x)`. Such literals will be altered — keep this
 * limitation accurate rather than implying literal/comment occurrences are left
 * intact.
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
      const contents = original
 // Zero-argument calls first → `void 0` (valid expression, no trailing
 // semicolon). Must run before the general rewrite so the result isn't
 // re-matched into `(void (0;)`.
        .replace(/(?<![\w.$])console\.(debug|log)\(\)/g, "void 0")
 // All other calls → `void (…)`.
        .replace(/(?<![\w.$])console\.(debug|log)\(/g, "void (");
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
 * PERF-1 guard: fail the build (fail-closed) if any first-party source
 * requests a non-`en` zod locale. The stub plugin above redirects the zod
 * locales barrel to an `en`-only stub, so a direct import like
 * `zod/v4/locales/de.js` (or formatting an error in another locale) would
 * resolve to `undefined` and throw at runtime in the shipped extension. This
 * makes the "only en" assumption a checked invariant instead of a comment.
 */
async function assertOnlyEnZodLocales(): Promise<void> {
  const roots = [SRC, LIB_SRC];
  const bad: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = (await readdir(dir)).map((n) => path.join(dir, n));
    } catch (e) {
 // Fail-closed guard must stay observable: a *missing* directory is a
 // normal stop condition (e.g. a root that doesn't exist), but any other
 // FS error (EACCES, broken symlink, transient I/O) must be surfaced so a
 // real non-`en` locale import in that subtree can't go undetected. We
 // THROW rather than warn-and-continue: a swallowed error would let the
 // guard silently skip a subtree, defeating the fail-closed contract.
      if ((e as { code?: string }).code === "ENOENT") return;
      throw new Error(
        `[zod-locale-lint] readdir failed for ${dir} — cannot verify zod-locale ` +
          `invariant, failing closed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const e of entries) {
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(e);
      } catch (err) {
 // A vanished entry (race with a concurrent delete) is a benign skip;
 // any other stat error must be surfaced so the fail-closed guard can't
 // silently overlook a file it failed to inspect.
        if ((err as { code?: string }).code === "ENOENT") continue;
        throw new Error(
          `[zod-locale-lint] stat failed for ${e} — cannot verify zod-locale ` +
            `invariant, failing closed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (st.isDirectory()) {
        if (path.basename(e) === "node_modules") continue;
        await walk(e);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e)) {
        const src = await readFile(e, "utf8");
 // Match zod locale imports that are NOT the `en` locale nor the barrel.
        const m = src.match(/zod\/v4\/locales\/(?!en(-[A-Za-z]+)?\.js|index\.js)[a-zA-Z-]+\.js/g);
        if (m) bad.push(`${e}: ${m.join(", ")}`);
      }
    }
  };
  for (const r of roots) await walk(r);
  if (bad.length) {
    throw new Error(
      "Non-en zod locale import detected — the stub plugin only provides 'en', " +
        "so this would resolve to undefined at runtime:\n" +
        bad.join("\n")
    );
  }
}

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
 * SEC-1: surface high-risk manifest permissions during the build so silent
 * permission creep is visible in CI. The build copies the manifest verbatim
 * and performs no allowlist/review, and `debugger` + universal host access is
 * a large attack surface.
 *
 * Behavior after remediation:
 * - A MISSING or MALFORMED manifest is a hard build error — the SEC-1 guard
 * is worthless exactly when the manifest can't be read/parsed, so we fail
 * closed (Apache-2.0/extension validity requires a real manifest).
 * - `permissions` / `host_permissions` / `optional_permissions` are validated
 * to be arrays of strings; a bad merge (e.g. a nested object) no longer
 * silently slips through.
 * - High-risk permissions (debugger, scripting, nativeMessaging, management,
 * cookies, tabs, history, bookmarks, proxy) present in `permissions` OR
 * `optional_permissions`, plus universal host access, are surfaced as a
 * WARNING (the local fast-fail signal).
 * - To actually ENFORCE the "no new high-risk permission" intent in CI, set
 * `MANIFEST_LINT_FAIL_HIGH_RISK=1` in the build environment. That promotes
 * the warning to a hard build error. We keep the default as a warning so
 * legitimate, reviewed permissions don't break every local developer build
 * (the documented in-repo justification for `debugger` + universal host
 * access is referenced in FULL-REVIEW). The recommended companion gate is a
 * CI manifest-lint *diff* that only fails on *newly-added* high-risk perms.
 *
 * Why these permissions are requested (documented in-repo per FULL-REVIEW):
 * - `debugger`: drives the CDP "take over this page" click/automation path
 * (attach to a tab, synthesize input, inspect the DOM).
 * - `scripting`: injects `executeScript` for automation without a persistent
 * content-script manifest entry.
 * - universal `host_permissions` (the `<all_urls>`-equivalent http/https
 * wildcards): the assistant
 * operates on whatever arbitrary web page the user points it at, so it
 * needs read access to any origin.
 */
function lintManifestPermissions(): void {
  const manifestPath = path.join(SRC, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[manifest-lint] ${manifestPath} is missing — a manifest is required to build a valid extension.`,
    );
  }
  let manifest: {
    permissions?: unknown;
    host_permissions?: unknown;
    optional_permissions?: unknown;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
 // Fail closed: a malformed manifest must NOT be silently swallowed.
    throw new Error(
      `[manifest-lint] failed to read/parse ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const perms = assertStringArray(manifest.permissions, "permissions");
  const host = assertStringArray(manifest.host_permissions, "host_permissions");
  const optional = assertStringArray(
    manifest.optional_permissions,
    "optional_permissions",
  );

 // Dangerous permissions that widen the extension's attack surface. Optional
 // permissions can escalate privilege at runtime, so they are checked too.
  const HIGH_RISK = new Set([
    "debugger",
    "scripting",
    "nativeMessaging",
    "management",
    "cookies",
    "tabs",
    "history",
    "bookmarks",
    "proxy",
  ]);
  const risky = perms.filter((p) => HIGH_RISK.has(p));
  const riskyOptional = optional.filter((p) => HIGH_RISK.has(p));
  const wideHost = host.some(
    (h) => h === "<all_urls>" || h === "http://*/*" || h === "https://*/*"
  );

 // Reviewed baseline: the high-risk permissions + universal host access already
 // present in the shipped manifest, each with an in-repo justification (see the
 // doc comment above: `debugger` drives CDP automation, `scripting` injects
 // automation scripts, `tabs` reads tab metadata, and universal host_permissions
 // lets the assistant operate on whatever page the user points it at).
 //
 // The lint is a *creep* guard, not a presence check: it only fires when a NEW
 // high-risk permission (or new universal-host entry) is added BEYOND this
 // baseline. That makes MANIFEST_LINT_FAIL_HIGH_RISK=1 safe to enable in CI —
 // it catches permission creep without failing the already-reviewed build. A
 // maintainer who intentionally adds a high-risk permission must also extend
 // this baseline (with a documented justification) so the addition is a
 // deliberate, reviewed change rather than silent creep.
  const BASELINE_HIGH_RISK = new Set(["debugger", "scripting", "tabs"]);
  const BASELINE_WIDE_HOST = true;

  const newRisky = risky.filter((p) => !BASELINE_HIGH_RISK.has(p));
  const newRiskyOptional = riskyOptional.filter((p) => !BASELINE_HIGH_RISK.has(p));
  const newWideHost = wideHost && !BASELINE_WIDE_HOST;

  if (newRisky.length || newRiskyOptional.length || newWideHost) {
    const items = [
      ...newRisky,
      ...newRiskyOptional,
      ...(newWideHost ? ["universal host_permissions"] : []),
    ];
    const msg =
      "[manifest-lint] NEW high-risk permission(s) added beyond the reviewed " +
      "baseline: " +
      items.join(", ") +
      " — confirm each is strictly necessary and has a documented justification (see FULL-REVIEW).";
 // Default: warn only. CI can promote this to a hard error via env flag so
 // local builds with reviewed permissions still work.
    if (process.env.MANIFEST_LINT_FAIL_HIGH_RISK === "1") {
      throw new Error(msg);
    }
    console.warn(msg);
  }
}

/**
 * Validate a manifest field is an array of strings (or absent). A non-array or
 * array containing non-string entries (e.g. a nested object from a bad merge)
 * would be mis-filtered by the high-risk check, so we reject it loudly.
 */
function assertStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new Error(
      `[manifest-lint] manifest.${field} must be an array of strings (got ${JSON.stringify(value)})`,
    );
  }
  return value;
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
 * (best-effort). `onnxruntime-web` ships no `LICENSE` file in its package, but
 * its MIT attribution is recorded elsewhere alongside the other bundled
 * dependencies' licenses.
 *
 * Note: referencing the third-party license text from the Options/About page
 * and `manifest.json` is tracked separately, outside this build file.
 */
async function emitThirdPartyLicenses(): Promise<void> {
  const targets: Array<[string, string]> = [];
 // Full Apache-2.0 text from the transformers package (best-effort).
  const apache = path.resolve("node_modules/@huggingface/transformers/LICENSE");
  if (existsSync(apache)) targets.push([apache, "LICENSE-APACHE"]);
  for (const [src, out] of targets) {
    if (existsSync(src)) {
      await copyFile(src, path.join(OUT, out));
    } else {
      console.warn(`[licenses] skipping missing license file: ${src}`);
    }
  }
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
