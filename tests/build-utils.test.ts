import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  assertOnlyEnZodLocales,
  lintManifestPermissions,
  stripConsoleDebug,
} from "../build-utils";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "build-utils-"));
}

// Robust cleanup: a transient FS error (file briefly locked right after a test
// on some platforms, EMFILE, etc.) must not fail the run or leak a temp dir.
// Retries a few times (with libuv's own retry on EBUSY) and is a no-op if the
// dir is already gone. This never touches any assertion in the tests.
function removeTmpDir(dir: string | undefined): void {
  if (!dir) return;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

describe("stripConsoleDebug", () => {
  it("leaves console.log( inside a string literal intact", () => {
    const out = stripConsoleDebug('const s = "console.log(x)";');
    expect(out).toContain('"console.log(x)"');
    expect(out).not.toContain("void (");
  });

  it("leaves console.log( inside a // comment intact", () => {
    const out = stripConsoleDebug("// console.log(x)");
    expect(out).toContain("// console.log(x)");
  });

  it("does not rewrite a member-expression console (obj.console.log)", () => {
    const src = 'obj.console.log("x");';
    expect(stripConsoleDebug(src)).toBe(src);
  });

  it("emits void 0 for a zero-argument call", () => {
    expect(stripConsoleDebug("console.log();")).toBe("void 0;");
  });

  it("emits void (...) for a call with arguments", () => {
    expect(stripConsoleDebug('console.debug(x, y);')).toBe("void (x, y);");
  });

  it("rewrites a bare console.log call, preserving surrounding code", () => {
    const out = stripConsoleDebug('const a = 1; console.log(a); const b = 2;');
    expect(out).toContain("const a = 1;");
    expect(out).toContain("void (a);");
    expect(out).toContain("const b = 2;");
  });

  // Regression: a trailing comma is legal in a function-call argument list
  // (`console.debug(a, b,)`) but ILLEGAL in the `void (…)` grouping expression
  // we emit. It must be dropped, else the bundle is a SyntaxError
  // ("Unexpected ')'") and the background script fails to build.
  it("drops a trailing comma so the void(…) grouping stays valid", () => {
    const out = stripConsoleDebug('console.debug(\n  "msg",\n  x instanceof Error ? x.message : "",\n);');
    expect(out).toBe('void (\n  "msg",\n  x instanceof Error ? x.message : "");');
  });

  it("drops a trailing comma even with nested parens in the args", () => {
    const out = stripConsoleDebug('console.log("x", foo(bar),);');
    expect(out).toBe('void ("x", foo(bar));');
  });

  it("produces a parseable statement when the call had a trailing comma", () => {
    const out = stripConsoleDebug('try {} catch (e) {\n  console.debug(\n    "m",\n    e.message,\n  );\n}');
    expect(() => new Function(out)).not.toThrow();
  });

  // The optional-chained form must ALSO be rewritten. The matcher only accepts
  // `console.` otherwise, so `console?.debug/log` calls survive into production
  // bundles.
  it("rewrites optional-chained console?.log / console?.debug calls", () => {
    expect(stripConsoleDebug('console?.log("x");')).toBe('void ("x");');
    expect(stripConsoleDebug('console?.debug("x");')).toBe('void ("x");');
    expect(stripConsoleDebug("console?.log();")).toBe("void 0;");
  });

  // Only `${` opens a template interpolation. A bare `{` in template text must
  // not bump the depth, or the closing backtick goes unrecognized and
  // everything after it (incl. console.log calls) is silently skipped.
  it("does not treat a literal { in template text as an interpolation", () => {
    expect(stripConsoleDebug("const s = `{`; console.log(s);")).toBe(
      "const s = `{`; void (s);",
    );
  });

  it("still tracks real ${...} interpolations", () => {
    const src = "const s = `${a} and ${b}`; console.log(s);";
    expect(stripConsoleDebug(src)).toBe("const s = `${a} and ${b}`; void (s);");
  });

  it("rewrites console.log inside a template interpolation", () => {
    const src = "const s = `${console.log(x)}`;";
    expect(stripConsoleDebug(src)).toBe("const s = `${void (x)}`;");
  });

  it("leaves console.log( inside a block comment intact", () => {
    const out = stripConsoleDebug("/* console.log(x) */");
    expect(out).toContain("/* console.log(x) */");
    expect(out).not.toContain("void (");
  });

  // A leading spread argument would become `void (...args)` — a SyntaxError —
  // so the original call must survive verbatim.
  it("leaves a leading-spread call untouched", () => {
    expect(stripConsoleDebug("console.log(...args);")).toBe("console.log(...args);");
  });

  // Documented hazard: a mid-spread argument rewrites to `void (a, ...b)`,
  // which is a SyntaxError at build time. No first-party source hits this
  // today, so the rewrite is pinned as-is rather than attempting a scope-aware
  // fix (the scanner is textual, not an AST walk).
  it("rewrites a mid-spread call (documented SyntaxError hazard)", () => {
    expect(stripConsoleDebug("console.log(a, ...b);")).toBe("void (a, ...b);");
    expect(stripConsoleDebug('console.debug("prefix", ...rest);')).toBe(
      'void ("prefix", ...rest);',
    );
  });
});

describe("lintManifestPermissions", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    removeTmpDir(dir);
    delete process.env.MANIFEST_LINT_FAIL_HIGH_RISK;
    vi.restoreAllMocks();
  });

  function writeManifest(obj: unknown): string {
    const p = path.join(dir, "manifest.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  const BASELINE = {
    permissions: ["debugger", "scripting", "tabs"],
    host_permissions: ["http://*/*", "https://*/*"],
    optional_permissions: [],
  };

  it("does not warn for the reviewed baseline", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lintManifestPermissions(writeManifest(BASELINE));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on a universal host pattern beyond the reviewed baseline", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lintManifestPermissions(
      writeManifest({
        ...BASELINE,
        host_permissions: ["http://*/*", "https://*/*", "<all_urls>"],
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("universal host_permissions");
    expect(warn.mock.calls[0][0]).toContain("<all_urls>");
  });

  it("warns on a newly-added high-risk permission", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lintManifestPermissions(
      writeManifest({ ...BASELINE, permissions: ["debugger", "scripting", "tabs", "history"] }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("NEW high-risk");
  });

  it("throws on new high-risk permission when MANIFEST_LINT_FAIL_HIGH_RISK=1", () => {
    process.env.MANIFEST_LINT_FAIL_HIGH_RISK = "1";
    expect(() =>
      lintManifestPermissions(
        writeManifest({
          ...BASELINE,
          optional_permissions: ["history"],
        }),
      ),
    ).toThrow(/NEW high-risk/);
  });

  it("throws on a new universal host pattern when MANIFEST_LINT_FAIL_HIGH_RISK=1", () => {
    process.env.MANIFEST_LINT_FAIL_HIGH_RISK = "1";
    expect(() =>
      lintManifestPermissions(
        writeManifest({
          ...BASELINE,
          host_permissions: ["http://*/*", "https://*/*", "<all_urls>"],
        }),
      ),
    ).toThrow(/NEW high-risk/);
  });

  it("the shipped source manifest passes under MANIFEST_LINT_FAIL_HIGH_RISK=1", () => {
    // The CI gate: the REAL manifest (default path) must not trip the
    // fail-closed mode — a regression here breaks CI, not just a warning.
    process.env.MANIFEST_LINT_FAIL_HIGH_RISK = "1";
    expect(() => lintManifestPermissions()).not.toThrow();
  });

  it("fails closed on a malformed manifest", () => {
    const p = path.join(dir, "manifest.json");
    writeFileSync(p, "{not json");
    expect(() => lintManifestPermissions(p)).toThrow(/manifest-lint/);
  });

  it("fails closed on a missing manifest", () => {
    expect(() =>
      lintManifestPermissions(path.join(dir, "does-not-exist.json")),
    ).toThrow(/missing/);
  });
});

describe("assertOnlyEnZodLocales", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    removeTmpDir(dir);
  });

  function writeSrc(name: string, contents: string): void {
    writeFileSync(path.join(dir, name), contents);
  }

  it("accepts an en locale import", async () => {
    writeSrc("a.ts", 'import "zod/v4/locales/en.js";');
    await expect(assertOnlyEnZodLocales([dir])).resolves.toBeUndefined();
  });

  it("rejects a non-en concrete locale import", async () => {
    writeSrc("a.ts", 'import "zod/v4/locales/de.js";');
    await expect(assertOnlyEnZodLocales([dir])).rejects.toThrow(
      /Non-en zod locale/,
    );
  });

  it("rejects a barrel import", async () => {
    writeSrc("a.ts", 'import "zod/v4/locales";');
    await expect(assertOnlyEnZodLocales([dir])).rejects.toThrow(
      /barrel import/,
    );
  });
});
