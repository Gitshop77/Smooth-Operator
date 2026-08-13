/**
 * Small, dependency-free Markdown renderer for model-authored chat output.
 * It creates an allow-listed DOM tree and never interprets raw HTML, keeping
 * the extension CSP boundary intact while supporting the formatting models
 * commonly emit: headings, paragraphs, lists, quotes, code, emphasis, links,
 * and horizontal rules.
 */

function safeLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function appendInline(parent: HTMLElement, source: string): void {
  const token = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(source.slice(cursor, index)));
    const value = match[0];
    if (value.startsWith("**") || value.startsWith("__")) {
      const strong = document.createElement("strong");
      appendInline(strong, value.slice(2, -2));
      parent.append(strong);
    } else if (value.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = value.slice(1, -1);
      parent.append(code);
    } else if (value.startsWith("[")) {
      const split = value.lastIndexOf("](");
      const label = value.slice(1, split);
      const href = safeLink(value.slice(split + 2, -1));
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        appendInline(link, label);
        parent.append(link);
      } else {
        parent.append(document.createTextNode(label));
      }
    } else {
      const emphasis = document.createElement("em");
      appendInline(emphasis, value.slice(1, -1));
      parent.append(emphasis);
    }
    cursor = index + value.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function appendParagraph(root: HTMLElement, lines: string[]): void {
  if (!lines.length) return;
  const paragraph = document.createElement("p");
  appendInline(paragraph, lines.map((line) => line.trim()).join(" "));
  root.append(paragraph);
}

/** Render trusted-as-text Markdown into a detached, allow-listed fragment. */
export function renderSafeMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const root = document.createElement("div");
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    appendParagraph(root, paragraph);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flushParagraph();
      const language = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language) code.dataset.language = language;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      root.append(pre);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const h = document.createElement(`h${heading[1].length}`);
      appendInline(h, heading[2]);
      root.append(h);
      i++;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      root.append(document.createElement("hr"));
      i++;
      continue;
    }
    const listMatch = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const ordered = Boolean(listMatch[2]);
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const item = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[i]);
        if (!item || Boolean(item[2]) !== ordered) break;
        const li = document.createElement("li");
        appendInline(li, item[3]);
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = document.createElement("blockquote");
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      appendInline(quote, quoteLines.join(" "));
      root.append(quote);
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flushParagraph();
  while (root.firstChild) fragment.append(root.firstChild);
  return fragment;
}
