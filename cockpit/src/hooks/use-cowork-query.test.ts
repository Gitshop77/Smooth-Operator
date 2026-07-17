import { describe, it, expect } from "vitest";

import { redactErrorSnippet } from "@/hooks/use-cowork-query";

describe("redactErrorSnippet", () => {
  it("masks a generic token value", () => {
    const out = redactErrorSnippet('token: "x"');
    expect(out).toContain("***");
    expect(out).not.toContain('"x"');
  });

  it("masks an Authorization bearer token", () => {
    const out = redactErrorSnippet("Authorization: Bearer eyJabc.def.ghi");
    expect(out).toContain("***");
    expect(out).not.toContain("eyJabc");
  });

  it("masks a postgres connection string password", () => {
    expect(redactErrorSnippet("postgres://user:pass@host")).toBe("postgres://user:***@host");
  });

  it("masks a redis connection string with an empty user", () => {
    expect(redactErrorSnippet("redis://:password@host")).toBe("redis://:***@host");
  });

  it("masks a password containing an embedded @", () => {
    expect(redactErrorSnippet("postgres://u:p@ss@host")).toBe("postgres://u:***@host");
  });
});
