import { describe, expect, test } from "vitest";
import { renderSafeMarkdown } from "../src/extension/sidepanel/safe-markdown";

function render(source: string): HTMLElement {
  const host = document.createElement("div");
  host.append(renderSafeMarkdown(source));
  return host;
}

describe("safe Markdown renderer", () => {
  test("renders headings, paragraphs, emphasis, and lists", () => {
    const host = render("## Result\n\n**Two** astronauts remain.\n\n1. First\n2. Second");
    expect(host.querySelector("h2")?.textContent).toBe("Result");
    expect(host.querySelector("strong")?.textContent).toBe("Two");
    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelectorAll("ol li")).toHaveLength(2);
  });

  test("renders ***bold italic*** as strong-wrapped emphasis", () => {
    const host = render("This is ***very important*** work.");
    const strong = host.querySelector("strong");
    const em = host.querySelector("em");
    expect(em).not.toBeNull();
    expect(strong?.contains(em)).toBe(true);
    expect(em?.textContent).toBe("very important");
    // Plain **bold** and *emphasis* still resolve independently.
    expect(render("**a** and *b*").querySelector("em")?.textContent).toBe("b");
  });

  test("never interprets raw HTML or unsafe links", () => {
    const host = render('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [good](https://example.com)');
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("renders fenced code as inert text", () => {
    const host = render("```html\n<script>alert(1)</script>\n```");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("pre code")?.textContent).toContain("<script>");
  });
});
