/**
 * `find_elements` must not leak sensitive attribute values.
 *
 * The handler routes attribute extraction through `isSensitive` (the same
 * classifier used by the DOM extractor's `buildAttrs`) and `redactSecrets`, so
 * a password / OTP / credit-card `value` is redacted to `[value redacted]`
 * while non-sensitive attributes are returned verbatim.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import { handleFindElements } from "../src/lib/agent/tools/handlers/find-elements";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import { setSecret, deleteSecret } from "../src/lib/agent/secrets";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

beforeAll(installLocalStorageStub);
afterAll(restoreLocalStorageStub);

const DUMMY_CTX = {} as ActionContext;

/** Parse the `Elements:\n0: {...}\n1: {...}` payload into structured rows. */
function parseElementRows(content: string | undefined): Record<string, string>[] {
  return (content ?? "")
    .split("\n")
    .filter((l) => l.includes("{"))
    .map((l) => JSON.parse(l.replace(/^\d+:\s*/, "")) as Record<string, string>);
}

describe("find_elements sensitive-attribute redaction", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="pw" type="password" value="supersecret">
      <input id="otp" type="text" autocomplete="one-time-code" value="000999">
      <input id="cc" type="text" autocomplete="cc-number" value="4111111111111111">
      <input id="name" type="text" value="alice">
      <div id="d" data-x="meta-info">hi</div>
    `;
  });

  test("redacts a stored secret appearing in a non-value attribute", async () => {
    await setSecret("apitoken", "sk_live_test_123");
    try {
      document.body.innerHTML = `<div id="tok" data-token="sk_live_test_123">hi</div>`;
      const res = await handleFindElements(DUMMY_CTX, {
        type: "find_elements",
        selector: "#tok",
        attributes: ["data-token"],
        max_results: 50,
      });
      expect(res.success).toBe(true);
      const rows = parseElementRows(res.extractedContent);
      expect(rows).toHaveLength(1);
      expect(rows[0]["data-token"]).toBe("[REDACTED:apitoken]");
      expect(res.extractedContent).not.toContain("sk_live_test_123");
    } finally {
      await deleteSecret("apitoken");
    }
  });

  test("redacts a stored secret appearing directly in a value attribute", async () => {
    await setSecret("pw", "hunter2");
    try {
      document.body.innerHTML = `<input id="s" type="text" value="hunter2">`;
      const res = await handleFindElements(DUMMY_CTX, {
        type: "find_elements",
        selector: "#s",
        attributes: ["value"],
        max_results: 50,
      });
      expect(res.success).toBe(true);
      expect(res.extractedContent).toContain("[REDACTED:pw]");
      expect(res.extractedContent).not.toContain("hunter2");
    } finally {
      await deleteSecret("pw");
    }
  });

  test("redacts password / OTP / credit-card value but keeps non-sensitive attrs", async () => {
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "input, div",
      attributes: ["value", "data-x"],
      max_results: 50,
    });
    expect(res.success).toBe(true);
    const out = res.extractedContent ?? "";
    const rows = parseElementRows(out);

    // Sensitive `value`s are redacted — the raw secrets must NOT appear.
    expect(out).toContain("[value redacted]");
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("000999");
    expect(out).not.toContain("4111111111111111");

    // Structural: password input value redacted; non-sensitive value + attr kept.
    expect(rows[0].value).toBe("[value redacted]");
    expect(rows[3].value).toBe("alice");
    expect(rows[4]["data-x"]).toBe("meta-info");
  });

  test("returns the real value for a non-sensitive input", async () => {
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "#name",
      attributes: ["value"],
      max_results: 50,
    });
    expect(res.extractedContent).toContain('"value":"alice"');
  });

  test("preserves behavior for non-sensitive attributes when no value requested", async () => {
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "#d",
      attributes: ["data-x"],
      max_results: 50,
    });
    expect(res.extractedContent).toContain('"data-x":"meta-info"');
  });
});

describe("find_elements link:<pseudo> locator", () => {
  test("rewrites link:<pseudo> to a:<pseudo> so anchors are queried, not <link>", async () => {
    const spy = vi.spyOn(document, "querySelectorAll");
    try {
      const res = await handleFindElements(DUMMY_CTX, {
        type: "find_elements",
        selector: "link:hover",
        max_results: 50,
      });
      expect(spy).toHaveBeenCalledWith("a:hover");
      expect(res.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("still uses link text for plain link locators (not diverted to CSS)", async () => {
    document.body.innerHTML = `<a id="login" href="#login">Log in</a>`;
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "link:Log in",
      max_results: 50,
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).toContain("<a>");
  });
});

describe("find_elements max_results truncation", () => {
  test("caps returned element rows at max_results (token-safety bound)", async () => {
    document.body.innerHTML = `
      <div>a</div><div>b</div><div>c</div><div>d</div><div>e</div>
    `;
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "div",
      max_results: 2,
    });
    expect(res.success).toBe(true);
    const rows = (res.extractedContent ?? "")
      .split("\n")
      .filter((l) => /^\d+:\s*</.test(l));
    expect(rows).toHaveLength(2);
  });
});

describe("find_elements redaction-failure masking", () => {
  beforeEach(async () => {
    // listSecrets caches the secret list across calls (only setSecret /
    // deleteSecret invalidate it). Earlier describes leave a cached EMPTY
    // list, which would short-circuit the failing-store path below. Invalidate
    // the cache through the public API so the failure test really hits
    // chrome.storage.session.
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
    await deleteSecret("__cache_reset__");
    delete (globalThis as Record<string, unknown>).chrome;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("when redactSecrets fails, NO raw value leaks (every part is masked)", async () => {
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        session: {
          get: vi.fn().mockRejectedValue(new Error("SW asleep")),
        },
      },
    };
    document.body.innerHTML = `
      <div id="a" data-token="tok-AAAA">x</div>
      <div id="b" data-token="tok-BBBB">y</div>
      <div id="c" data-token="tok-CCCC">z</div>
    `;
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "div",
      attributes: ["data-token"],
      max_results: 50,
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).not.toContain("tok-AAAA");
    expect(res.extractedContent).not.toContain("tok-BBBB");
    expect(res.extractedContent).not.toContain("tok-CCCC");
    expect(res.extractedContent).toContain("[REDACTED");
  });

  test("a NUL byte inside a value cannot shift the split so raw text leaks", async () => {
    const div = document.createElement("div");
    div.id = "n";
    div.setAttribute("data-token", "part1\u0000part2");
    document.body.appendChild(div);
    const res = await handleFindElements(DUMMY_CTX, {
      type: "find_elements",
      selector: "#n",
      attributes: ["data-token"],
      max_results: 50,
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).not.toContain("part1");
    expect(res.extractedContent).not.toContain("part2");
  });
});
