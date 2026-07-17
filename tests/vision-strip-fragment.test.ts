/**
 * vision.ts — stripUrlFragment hash-route vs anchor discrimination.
 *
 * SPA hash-route / hashbang fragments (`#/...`, `#!...`) change the visible
 * content (cached vision rects would be stale), so they must be kept in the
 * cache key. Plain anchors (`#section`) do not change layout, so they are
 * dropped. Query strings always stay.
 */

import { describe, test, expect } from "vitest";
import { stripUrlFragment } from "../src/extension/background/vision";

describe("stripUrlFragment", () => {
  test("preserves a hash-route fragment (#/settings)", () => {
    expect(stripUrlFragment("https://a.com/#/settings")).toBe("https://a.com/#/settings");
  });

  test("preserves a hashbang fragment (#!x)", () => {
    expect(stripUrlFragment("https://a.com/#!x")).toBe("https://a.com/#!x");
  });

  test("drops a plain anchor fragment (#section)", () => {
    expect(stripUrlFragment("https://a.com/#section")).toBe("https://a.com/");
  });

  test("leaves a no-fragment URL unchanged", () => {
    expect(stripUrlFragment("https://a.com/path")).toBe("https://a.com/path");
  });

  test("keeps the query string when dropping an anchor", () => {
    expect(stripUrlFragment("https://a.com/?q=1#section")).toBe("https://a.com/?q=1");
  });

  test("keeps the query string with a hash-route fragment", () => {
    expect(stripUrlFragment("https://a.com/?q=1#/settings")).toBe("https://a.com/?q=1#/settings");
  });
});
