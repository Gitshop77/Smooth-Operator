/**
 * Redaction parity test.
 *
 * The extension ships two secret redactors that must never leak the same
 * secrets, backed by a single canonical shape-detection source:
 *
 *   • `redactKeyShapes` (src/lib/agent/key-shape-redact.ts) — the CANONICAL
 *     key-shape redactor. Used by the agent pipeline (messages.ts /
 *     compaction.ts) before history is sent to the LLM. Deliberately
 *     conservative: only well-known, long key-shapes, masks with `[redacted]` /
 *     `Bearer [redacted]`. It must NOT over-redact agent history (and its
 *     callers' behaviour is pinned by messages-/compaction-/injection-defense
 *     tests), so it intentionally does not do JSON-value or high-entropy
 *     scalar masking.
 *
 *   • `redactKeyLeak` (src/extension/shared.ts) — the UI-surface redactor
 *     (options test-connection, side-panel log / thinking renderers). It keeps
 *     the key prefix for operator signal (`sk-[REDACTED]`), masks JSON secret
 *     values and high-entropy quoted scalars, and DELEGATES its final pass to
 *     `redactKeyShapes` so both surfaces share one shape-detection source.
 *
 * Because the two serve different surfaces they use different display markers
 * and transforms, so this test proves PARITY OF COVERAGE (identical masking),
 * not byte-identical strings:
 *   - every well-known key-shape is masked by BOTH (redactKeyLeak delegates to
 *     the canonical, so coverage is a superset of redactKeyShapes);
 *   - non-secret input is preserved identically by both;
 *   - redactKeyLeak's UI-only extras (JSON values, high-entropy scalars, short
 *     keys) are documented as intentionally NOT in the conservative agent
 *     redactor.
 *
 * The cockpit pair `redactSecrets` / `redactClientSecrets` (both emit `***`) is
 * proven BYTE-IDENTICAL in `cockpit/src/lib/redact-client.test.ts`, since those
 * two share a marker and redact-client.ts is a lock-step mirror of http.ts.
 */

import { describe, test, expect } from "vitest";
import { redactKeyShapes } from "../src/lib/agent/key-shape-redact";
import { redactKeyLeak } from "../src/extension/shared";

describe("redactKeyShapes (canonical) vs redactKeyLeak — shared shape coverage", () => {
  // Each entry: a secret-shaped string and the raw secret body that must not
  // survive in EITHER redactor's output.
  const SHARED: Array<{ name: string; input: string; secret: string }> = [
    { name: "long sk- key", input: `sk-${"a".repeat(24)}`, secret: "a".repeat(24) },
    { name: "AKIA key", input: `AKIA${"Q".repeat(16)}`, secret: `AKIA${"Q".repeat(16)}` },
    { name: "AIza key", input: `AIza${"a".repeat(35)}`, secret: `AIza${"a".repeat(35)}` },
    { name: "ghp_ token", input: `ghp_${"a".repeat(36)}`, secret: `ghp_${"a".repeat(36)}` },
    {
      name: "JWT",
      input:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      secret:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    },
    {
      name: "Bearer token",
      input: "Authorization: Bearer abcdefghijklmnop",
      secret: "abcdefghijklmnop",
    },
    {
      // DB connection string: covered by redactKeyShapes, and reached by
      // redactKeyLeak only because it delegates to the canonical as a final
      // pass. Proves the single-source wiring works end-to-end.
      name: "postgres connection string",
      input: "postgres://user:pass@db.example.com:5432/app",
      secret: "pass",
    },
  ];

  for (const s of SHARED) {
    test(`${s.name}: redactKeyShapes masks the secret`, () => {
      const out = redactKeyShapes(s.input);
      expect(out).not.toContain(s.secret);
      expect(out).not.toBe(s.input);
    });

    test(`${s.name}: redactKeyLeak masks the secret (delegates to canonical)`, () => {
      const out = redactKeyLeak(s.input);
      expect(out).not.toContain(s.secret);
      expect(out).not.toBe(s.input);
    });
  }
});

describe("redactKeyLeak UI-only extras (intentionally absent from conservative agent redactor)", () => {
  test("masks a JSON secret value", () => {
    const out = redactKeyLeak('{"password":"Tr0ub4dor&3"}');
    expect(out).not.toContain("Tr0ub4dor&3");
    expect(out).toBe('{"password":"[REDACTED]"}');
  });

  test("masks a high-entropy quoted scalar", () => {
    const out = redactKeyLeak('"aB3$xY9qLm2!zK7wRt5vNh8uCp4"');
    expect(out).not.toContain("aB3$xY9qLm2!zK7wRt5vNh8uCp4");
    expect(out).toBe('"[REDACTED]"');
  });

  test("masks a short sk- key the canonical (long-only) redactor leaves alone", () => {
    const input = "401: Invalid API key: sk-proj-abc123";
    expect(redactKeyLeak(input)).toBe("401: Invalid API key: sk-[REDACTED]");
    // redactKeyShapes is intentionally conservative (long keys only) for the
    // agent pipeline; it does NOT mask this short key.
    expect(redactKeyShapes(input)).toBe(input);
  });
});

describe("redactKeyShapes and redactKeyLeak preserve identical non-secret input", () => {
  const CLEAN: Array<{ name: string; input: string }> = [
    { name: "plain text", input: "Hello, this is a normal message with no secrets." },
    { name: "email (unquoted)", input: "contact alice@example.com today" },
    {
      // The extension redactors intentionally do NOT mask generic `token=`
      // query params or https userinfo (that is the cockpit `redactSecrets`
      // job). Both must therefore leave this untouched — identical passthrough.
      name: "url with token",
      input: "https://user:pass@api.example.com/v1?token=abcdef123456",
    },
  ];

  for (const c of CLEAN) {
    test(`${c.name}: both return the input unchanged`, () => {
      expect(redactKeyShapes(c.input)).toBe(c.input);
      expect(redactKeyLeak(c.input)).toBe(c.input);
    });
  }
});
