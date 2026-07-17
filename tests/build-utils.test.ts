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
});

describe("lintManifestPermissions", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
    host_permissions: ["<all_urls>"],
    optional_permissions: [],
  };

  it("does not warn for the reviewed baseline", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lintManifestPermissions(writeManifest(BASELINE));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on a newly-added high-risk permission", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lintManifestPermissions(
      writeManifest({ ...BASELINE, permissions: ["debugger", "scripting", "tabs", "cookies"] }),
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
          optional_permissions: ["cookies"],
        }),
      ),
    ).toThrow(/NEW high-risk/);
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
    rmSync(dir, { recursive: true, force: true });
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
