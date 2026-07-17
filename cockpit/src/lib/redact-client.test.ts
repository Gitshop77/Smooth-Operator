import { describe, it, expect } from "vitest";

import { redactClientSecrets } from "@/lib/redact-client";
import { redactSecrets } from "@/lib/cowork/api/http";

// Corpus of secret-shaped strings. None of these depend on the server-side
// `process.env` token values (which are unset in tests), so the two redactors'
// regex-based shapes must agree on every entry.
const CORPUS = [
  "http://user:pass@example.com/path",
  "postgres://user:pass@host:5432/db",
  "mysql://u:p@db/prod",
  "mongodb://u:p@cluster.local",
  "password=supersecret",
  'api_key="sk-1234567890abcdef"',
  '"authorization": "Bearer xyz"',
  "Bearer abcd1234efgh",
  "Authorization: Basic dXNlcjpwYXNz",
  "token=abcdef123456",
  "gsk-ABCDEFGHIJKLMNOPQRSTUVWX",
  "xoxb-1234567890-0987654321-abcdefghijkl",
  "AKIAIOSFODNN7EXAMPLE",
  "sk-ant-abcdefghijklmnopqrstuvwxyz012345",
  "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "plain text with no secrets",
];

describe("redactClientSecrets parity with server redactSecrets", () => {
  for (const sample of CORPUS) {
    it(`masks the same shapes as redactSecrets: ${sample.slice(0, 40)}`, () => {
      expect(redactClientSecrets(sample)).toBe(redactSecrets(sample));
    });
  }

  it("never leaks a bearer token", () => {
    expect(redactClientSecrets("Bearer abcd1234efgh")).not.toContain("abcd1234efgh");
  });

  it("never leaks a connection-string password", () => {
    const out = redactClientSecrets("postgres://user:pass@host:5432/db");
    expect(out).not.toContain("pass");
    expect(out).toBe("postgres://***@host:5432/db");
  });
});

// Independent assertions — these pin the CLIENT redactor's expected MASKED
// output directly, NOT by comparing it to the server redactor. They exist so a
// coordinated weakening of BOTH redactors (the equality-only parity loop above
// would pass silently) is caught: each known-secret value must be masked.
describe("redactClientSecrets independent masking (decoupled from server parity)", () => {
  it("masks an AWS access-key literal (AKIA…) to ***", () => {
    expect(redactClientSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("***");
  });

  it("masks a GitHub token literal (ghp_…) to ***", () => {
    expect(redactClientSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("***");
  });

  it("masks an Anthropic key literal (sk-ant-…) to ***", () => {
    expect(redactClientSecrets("sk-ant-abcdefghijklmnopqrstuvwxyz012345")).toBe("***");
  });

  it("masks a JWT literal to ***", () => {
    expect(
      redactClientSecrets(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toBe("***");
  });

  it("masks a Bearer token to the 'Bearer ***' shape", () => {
    expect(redactClientSecrets("Bearer abcd1234efgh")).toBe("Bearer ***");
  });

  it("masks a connection-string password to scheme://***@host", () => {
    expect(redactClientSecrets("postgres://user:pass@host:5432/db")).toBe(
      "postgres://***@host:5432/db",
    );
  });

  it("masks a password= key=value to password=***", () => {
    expect(redactClientSecrets("password=supersecret")).toBe("password=***");
  });

  it("masks a token= key=value to token=***", () => {
    expect(redactClientSecrets("token=abcdef123456")).toBe("token=***");
  });
});
