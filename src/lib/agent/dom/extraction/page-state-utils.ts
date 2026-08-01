import { DOM_CONFIG } from "./element-info";
import { isSensitive } from "../utils";

const MAX_ATTR_VALUE_LENGTH = 200;

function escapeAttr(v: string): string {
  let s = v
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_ATTR_VALUE_LENGTH) s = s.slice(0, MAX_ATTR_VALUE_LENGTH) + "...";
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function attrString(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    parts.push(`${k}="${escapeAttr(v)}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function buildPageInfo(scrollTop: number, scrollHeight: number, vh: number): string {
  const above = vh > 0 ? scrollTop / vh : 0;
  const below = vh > 0 ? Math.max(0, scrollHeight - scrollTop - vh) / vh : 0;
  let info = `${above.toFixed(1)} pages above, ${below.toFixed(1)} pages below`;
  if (below > 0.1) info += " — scroll down to reveal more content";
  return info;
}

interface VirtualChild {
  tag: string;
  text: string;
  attributes: Record<string, string>;
}

function buildCompoundChildren(el: HTMLElement): VirtualChild[] {
  const tag = el.tagName.toLowerCase();
  const children: VirtualChild[] = [];

  if (el instanceof HTMLSelectElement) {
    if (isSensitive(el)) {
      children.push({ tag: "option", text: "[value redacted]", attributes: {} });
      return children;
    }
    const opts = Array.from(el.options);
    const limit = Math.min(DOM_CONFIG.compoundOptionLimit, opts.length);
    for (let i = 0; i < limit; i++) {
      const o = opts[i];
      const text =
        (o.textContent || "").replace(/\s+/g, " ").trim() ||
        (o.value || "").replace(/\s+/g, " ");
      const attrs: Record<string, string> = { value: o.value };
      if (o.selected) attrs.selected = "";
      if (o.disabled) attrs.disabled = "";
      children.push({ tag: "option", text, attributes: attrs });
    }
    if (opts.length > limit) {
      const more = opts.length - limit;
      children.push({
        tag: "option",
        text: `... ${more} more option${more === 1 ? "" : "s"}`,
        attributes: {},
      });
    }
    return children;
  }

  if (tag === "input" && el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === "range") {
      const min = el.getAttribute("min") ?? "0";
      const max = el.getAttribute("max") ?? "100";
      const now = el.value || "";
      children.push({
        tag: "slider",
        text: "Value",
        attributes: { valuemin: min, valuemax: max, valuenow: now },
      });
    } else if (type === "file") {
      const files = el.files;
      let fileText = "No file chosen";
      if (files && files.length > 0) {
        fileText =
          files.length === 1
            ? (files[0].name || "").replace(/\s+/g, " ")
            : `${files.length} files selected`;
      }
      children.push({ tag: "button", text: "Browse Files", attributes: {} });
      children.push({ tag: "textbox", text: fileText, attributes: { label: "File Selected" } });
    }
    return children;
  }

  if (tag === "details") {
    const summary = el.querySelector("summary");
    const summaryText = summary
      ? (summary.textContent || "").replace(/\s+/g, " ").trim()
      : "";
    const open: Record<string, string> = el.hasAttribute("open") ? { open: "" } : {};
    children.push({
      tag: "summary",
      text: summaryText || "Toggle",
      attributes: open,
    });
    return children;
  }

  return children;
}

export {
  escapeAttr,
  attrString,
  buildPageInfo,
  buildCompoundChildren,
};
