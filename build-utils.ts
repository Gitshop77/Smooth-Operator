/**
 * build-utils.ts — testable extract of the security/perf transforms that live
 * in `esbuild.config.ts`.
 *
 * These three helpers are regex/string transforms on first-party source (and a
 * filesystem walk + a manifest lint). They guard real build-time invariants
 * (the console-strip must not corrupt UI copy; the zod-locale strip must stay
 * `en`-only; high-risk manifest permissions must not silently creep). Pulling
 * them out here lets `tests/build-utils.test.ts` exercise them directly
 * without bundling the whole extension.
 *
 * Each filesystem-touching helper takes its target path(s) as an optional
 * parameter so tests can point it at fixtures instead of the real tree.
 */

import { existsSync, readFileSync } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import path from "path";

const SRC = path.resolve("src/extension");
const LIB_SRC = path.resolve("src/lib");

/**
 * Strip first-party `console.debug`/`console.log` calls from a source file
 * while leaving occurrences inside string literals and comments untouched.
 *
 * A naive regex rewrite corrupts UI copy / help text when `console.log(` appears
 * inside a string (e.g. `const s = "console.log(x)"` → `"void (x)"`) or a
 * comment. This scanner walks the source tracking string/comment state, so it
 * only rewrites genuine `console.debug(...)` / `console.log(...)` call
 * expressions whose `console` binding is a bare identifier (preceded by a
 * non-identifier char), mirroring the original regex's `(?<![\w.$])` anchoring.
 * `void 0` is emitted for the zero-argument form; `void (…)` otherwise.
 */
export function stripConsoleDebug(source: string): string {
  const out: string[] = [];
  const n = source.length;
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let strChar: string | null = null; // '"' | "'" | "`"
  let templateDepth = 0; // `${ … }` nesting depth inside a template literal
  // Paren depth while we are inside a `void (…)` grouping that replaced a
  // `console.debug/log` call. Non-zero ⇒ the trailing-comma fix below is armed.
  // (Nested `console.*` calls inside a rewritten call are not tracked — the
  // first-party source contains none — but this still handles the common case
  // and any nested *non-console* parens correctly.)
  let voidCallDepth = 0;
  const isIdentChar = (c: string) => /[\w.$]/.test(c);

  while (i < n) {
    const c = source[i];
    const prev = i > 0 ? source[i - 1] : "";

    if (inLineComment) {
      out.push(c);
      if (c === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      out.push(c);
      if (c === "*" && source[i + 1] === "/") {
        out.push("/");
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Track template-literal `${ … }` nesting. This must run for backtick
    // strings whether we are in plain template text or inside a `${}`
    // interpolation, so the closing backtick is located correctly and the
    // interior of an interpolation is scanned as ordinary code below.
    // Depth only increments on `${` — a bare `{` in template text (e.g.
    // `const s = \`a { b\``) must NOT bump the depth, or an unmatched
    // literal brace would corrupt the close-backtick logic below.
    if (strChar === "`") {
      if (c === "{" && source[i - 1] === "$") { templateDepth++; out.push(c); i++; continue; }
      if (c === "}" && templateDepth > 0) { templateDepth--; out.push(c); i++; continue; }
      if (c === "`" && templateDepth === 0) { strChar = null; out.push(c); i++; continue; }
    }

    if (strChar !== null) {
      // Inside a template interpolation `${ … }` we scan the interior as
      // ordinary code so console.debug/log calls there are still rewritten.
      // The template-boundary chars were already handled above, so fall
      // through to the normal code-scanning path for everything else.
      if (strChar === "`" && templateDepth > 0) {
        // fall through
      } else {
        out.push(c);
        if (c === "\\") {
          if (i + 1 < n) {
            out.push(source[i + 1]);
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        if (strChar === "`") {
          if (c === "{" && source[i - 1] === "$") templateDepth++;
          else if (c === "}" && templateDepth > 0) templateDepth--;
          else if (c === "`" && templateDepth === 0) strChar = null;
        } else if (c === strChar) {
          strChar = null;
        }
        i++;
        continue;
      }
    }

    // Not inside a string or comment.
    if (c === "/" && source[i + 1] === "/") {
      inLineComment = true;
      out.push(c, "/");
      i += 2;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      inBlockComment = true;
      out.push(c, "*");
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      strChar = c;
      out.push(c);
      i++;
      continue;
    }

    // While rewriting a `console.debug/log` call into `void (…)`, the closing
    // `)` must drop any TRAILING COMMA. A function-call argument list
    // (`console.debug(a, b,)`) allows a trailing comma; the `void` *grouping*
    // expression we emit (`void (a, b,)`) does NOT — it is a SyntaxError
    // ("Unexpected ')'"). Track paren depth (respecting strings/comments/templates
    // via the scanner above) so we only fix the trailing comma at the void call's
    // own closing `)`, not at nested `)` (e.g. `void ( foo(x), )`).
    if (voidCallDepth > 0) {
      if (c === "(") {
        voidCallDepth++;
        out.push(c);
        i++;
        continue;
      }
      if (c === ")") {
        voidCallDepth--;
        if (voidCallDepth === 0) {
          // Strip a trailing comma (+ any surrounding whitespace) so
          // `void (a, b,)` becomes the valid `void (a, b)`.
          while (out.length && /\s/.test(out[out.length - 1])) out.pop();
          if (out.length && out[out.length - 1] === ",") out.pop();
          out.push(")");
        } else {
          out.push(")");
        }
        i++;
        continue;
      }
    }

    // Bare `console.debug(` / `console.log(` call → rewrite, and the
    // optional-chained forms `console?.debug(` / `console?.log(` too
    // (the plain `startsWith("console.", i)` check can never see the `?`
    // branch, so the chained form must be matched explicitly — without it
    // optional-chained calls survive into production bundles).
    if (c === "c" && !isIdentChar(prev)) {
      let nameOff: number;
      if (source.startsWith("console.", i)) nameOff = i + 8;
      else if (source.startsWith("console?.", i)) nameOff = i + 9;
      else {
        out.push(c);
        i++;
        continue;
      }
      const name =
        source[nameOff] === "d"
          ? "debug"
          : source[nameOff] === "l"
            ? "log"
            : null;
      if (name !== null) {
        const afterName = nameOff + name.length; // index of '('
        if (source[afterName] === "(") {
          if (source[afterName + 1] === ")") {
            out.push("void 0");
            i = afterName + 2;
            continue;
          }
          // A leading spread argument (e.g. `console.log(...args)`) would become
          // `void (...args)`, which is a SyntaxError: a leading spread is only valid
          // inside an array literal or a call argument list, not a parenthesized
          // expression. Skip the rewrite so the original call stays valid JS.
          if (/^\s*\.\.\./.test(source.slice(afterName + 1))) {
            out.push(c);
            i++;
            continue;
          }
          out.push("void (");
          voidCallDepth = 1; // the `(` in `void (` is our depth-1 opening paren
          i = afterName + 1; // skip the original '(' (already emitted by `void (`)
          continue;
        }
      }
    }

    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * PERF-1 guard: fail the build (fail-closed) if any first-party source
 * requests a non-`en` zod locale. The stub plugin in `esbuild.config.ts`
 * redirects the zod locales barrel to an `en`-only stub, so a direct import
 * like `zod/v4/locales/de.js` (or formatting an error in another locale)
 * would resolve to `undefined` and throw at runtime in the shipped extension.
 * This makes the "only en" assumption a checked invariant instead of a comment.
 *
 * `roots` defaults to the real first-party tree; tests pass fixture dirs.
 */
export async function assertOnlyEnZodLocales(
  roots: string[] = [SRC, LIB_SRC],
): Promise<void> {
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
        const m = src.match(/zod\/v4\/locales\/(?!en(-[A-Za-z]+)?(\.js)?|index(\.js)?)[a-zA-Z-]+(\.js)?/g);
        if (m) bad.push(`${e}: ${m.join(", ")}`);
        // Reject the barrel import (`zod/v4/locales` or its `index.js`) entirely.
        // A namespace/`* as` import of the barrel resolves to the `en`-only stub
        // when reached from zod's internals, so any non-`en` key access returns
        // `undefined` at runtime — a silent crash this per-file regex cannot see.
        // Requiring an explicit concrete locale (e.g. `zod/v4/locales/en.js`) keeps
        // the fail-closed contract intact. The stub itself imports `en.js`, so it
        // is not flagged here.
        const barrel = src.match(/['"]zod\/v4\/locales['"]|['"]zod\/v4\/locales\/index\.js['"]/g);
        if (barrel) {
          bad.push(`${e}: barrel import ${barrel.join(", ")} — import a concrete locale (e.g. zod/v4/locales/en.js) instead`);
        }
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
 * Validate a manifest field is an array of strings (or absent). A non-array or
 * array containing non-string entries (e.g. a nested object from a bad merge)
 * would be mis-filtered by the allowlist check, so we reject it loudly.
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

// Exact reviewed permission vocabulary for the shipped manifest. Membership is
// fail-closed: a future permission is rejected even when it is absent from a
// hand-maintained "high risk" vocabulary. Optional permissions have a separate
// (currently empty) allowlist because they can widen authority at runtime.
const APPROVED_MANIFEST_PERMISSIONS = new Set([
  "sidePanel",
  "scripting",
  "tabs",
  "activeTab",
  "storage",
  "alarms",
  "debugger",
  "notifications",
  "downloads",
  "unlimitedStorage",
  "power",
  "webRequest",
  "cookies",
]);
const APPROVED_OPTIONAL_MANIFEST_PERMISSIONS = new Set<string>();

/**
 * SEC-1: enforce the exact reviewed manifest-permission vocabulary during the
 * build so silent permission creep is impossible. A MISSING or MALFORMED
 * manifest is a hard build error (fail-closed). Unapproved entries in
 * `permissions` OR `optional_permissions`, plus new universal host access, are
 * hard build errors. Reviewed permissions continue to pass; new privilege
 * cannot hide in a warning-only build path.
 *
 * `manifestPath` defaults to the real manifest; tests pass a fixture path.
 */
export function lintManifestPermissions(
  manifestPath: string = path.join(SRC, "manifest.json"),
): void {
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

  const unapproved = perms.filter((p) => !APPROVED_MANIFEST_PERMISSIONS.has(p));
  const unapprovedOptional = optional.filter(
    (p) => !APPROVED_OPTIONAL_MANIFEST_PERMISSIONS.has(p),
  );
  // Universal host patterns: match every (or every http/https) origin. Any
  // pattern in this set that is NOT in the reviewed baseline below is creep.
  const UNIVERSAL_HOST_PATTERNS: readonly string[] = [
    "<all_urls>",
    "http://*/*",
    "https://*/*",
  ];

  // The shipped manifest grants http/https everywhere (deliberately NOT
  // file:// or ftp://), so those two patterns are the reviewed baseline; any
  // other universal pattern (e.g. <all_urls>) extends access beyond it.
  const BASELINE_WIDE_HOST = new Set(["http://*/*", "https://*/*"]);

  const newWideHost = host.filter(
    (h) => UNIVERSAL_HOST_PATTERNS.includes(h) && !BASELINE_WIDE_HOST.has(h)
  );

  if (unapproved.length || unapprovedOptional.length || newWideHost.length) {
    const items = [
      ...unapproved.map((permission) => `permissions: ${permission}`),
      ...unapprovedOptional.map(
        (permission) => `optional_permissions: ${permission}`,
      ),
      ...(newWideHost.length
        ? [`universal host_permissions: ${newWideHost.join(", ")}`]
        : []),
    ];
    const msg =
      "[manifest-lint] unapproved manifest permission or host access: " +
      items.join(", ") +
      " — confirm each is strictly necessary and has a documented justification.";
    throw new Error(msg);
  }
}
