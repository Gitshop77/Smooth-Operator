import { describe, expect, it, afterEach } from "vitest";

import { BrowserService } from "@/server/browser/service";
import { Logger } from "@/server/logger";
import { SecurityPolicy } from "@/server/policy";
import type { BrowserAction } from "@/server/contracts";

import { testConfig } from "./helpers";

const ELEMENT = 1;
const TEXT = 3;

type FakeNode = {
  nodeType: number;
  nodeValue: string | null;
  tagName: string;
  childNodes: FakeNode[];
  children: FakeNode[];
  parentElement: FakeNode | null;
  id: string;
  attributes: Array<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number };
  closest(selector: string): FakeNode | null;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  getRootNode?(): FakeNode | { body: FakeNode };
  textContent: string;
  outerHTML: string;
  innerHTML: string;
};

function textNode(value: string): FakeNode {
  return {
    nodeType: TEXT,
    nodeValue: value,
    tagName: "",
    childNodes: [],
    children: [],
    parentElement: null,
    id: "",
    attributes: [],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0 }),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: value,
    outerHTML: value,
    innerHTML: value,
  };
}

function element(tag: string, attrs: Record<string, string> = {}, kids: FakeNode[] = []): FakeNode {
  const node: FakeNode = {
    nodeType: ELEMENT,
    nodeValue: null,
    tagName: tag.toUpperCase(),
    childNodes: kids,
    children: kids.filter((child) => child.nodeType === ELEMENT),
    parentElement: null,
    id: attrs.id ?? "",
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name) => Object.hasOwn(attrs, name),
    getBoundingClientRect: () => ({ x: 1, y: 1, width: 20, height: 10, top: 1, left: 1 }),
    closest(selector: string) {
      if (selector === "a" && tag.toLowerCase() === "a") {
        return node;
      }
      return this.parentElement?.closest(selector) ?? null;
    },
    querySelector(selector: string) {
      if (selector.startsWith("#") && this.id === selector.slice(1)) {
        return node;
      }
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) {
          return found;
        }
      }
      return null;
    },
    querySelectorAll(selector: string) {
      const found: FakeNode[] = [];
      const tag = selector.toLowerCase();
      if (selector.startsWith("#") && this.id === selector.slice(1)) {
        found.push(node);
      } else if (!selector.startsWith("#") && !selector.startsWith(".") && this.tagName.toLowerCase() === tag) {
        found.push(node);
      }
      for (const child of this.children) {
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    },
    getRootNode() {
      return node;
    },
    get textContent() {
      return kids.map((child) => child.textContent).join("");
    },
    outerHTML: `<${tag}${Object.entries(attrs).map(([name, value]) => ` ${name}="${value}"`).join("")}></${tag}>`,
    innerHTML: kids.map((child) => child.outerHTML).join(""),
  };
  for (const child of kids) {
    if (child.nodeType === ELEMENT) {
      child.parentElement = node;
    }
  }
  return node;
}

function installFakeDom(): () => void {
  const button = element("button", { id: "action-button" }, [textNode("Go")]);
  const heading = element("h1", {}, [textNode("Hello page")]);
  const area = element("textarea", { id: "private-text", name: "notes" }, [textNode("private-textarea-default-42")]);
  const script = element("script", {}, [textNode("private-script-source-42")]);
  const input = element("input", { id: "input", type: "text", value: "typed" });
  const body = element("body", {}, [heading, button, area, script, input, textNode(" visible copy ")]);
  const documentElement = element("html", {}, [body]);
  body.parentElement = documentElement;
  const fakeDocument = {
    body,
    documentElement,
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    elementFromPoint: () => button,
  };
  const fakeWindow = {
    innerWidth: 1_280,
    innerHeight: 720,
    scrollY: 0,
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      position: "static",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(255, 255, 255)",
      width: "20px",
      height: "10px",
      zIndex: "auto",
    }),
  };
  const computed = () => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "auto",
    position: "static",
    color: "rgb(0, 0, 0)",
    backgroundColor: "rgb(255, 255, 255)",
    width: "20px",
    height: "10px",
    zIndex: "auto",
  });
  fakeWindow.getComputedStyle = computed;
  const previous = {
    document: (globalThis as { document?: unknown }).document,
    window: (globalThis as { window?: unknown }).window,
    CSS: (globalThis as { CSS?: unknown }).CSS,
    getComputedStyle: (globalThis as { getComputedStyle?: unknown }).getComputedStyle,
  };
  const attachRoot = (node: FakeNode): void => {
    node.getRootNode = () => fakeDocument as unknown as FakeNode;
    for (const child of node.children) {
      attachRoot(child);
    }
  };
  attachRoot(documentElement);
  Object.assign(globalThis, {
    document: fakeDocument,
    window: fakeWindow,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    getComputedStyle: computed,
  });
  return () => {
    if (previous.document === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = previous.document;
    }
    if (previous.window === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previous.window;
    }
    if (previous.CSS === undefined) {
      delete (globalThis as { CSS?: unknown }).CSS;
    } else {
      (globalThis as { CSS?: unknown }).CSS = previous.CSS;
    }
    if (previous.getComputedStyle === undefined) {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    } else {
      (globalThis as { getComputedStyle?: unknown }).getComputedStyle = previous.getComputedStyle;
    }
  };
}

describe("in-page evaluators run against a fake DOM", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("collects a snapshot and extracts text without returning script or textarea secrets", async () => {
    restore = installFakeDom();
    const config = testConfig();
    const instance = new BrowserService(config, new SecurityPolicy(config), new Logger("error", {}, () => undefined));
    const page = {
      url: () => "http://127.0.0.1/",
      title: async () => "Hello page",
      viewport: () => ({ width: 1_280, height: 720 }),
      isClosed: () => false,
    };
    const frame = {
      url: () => "http://127.0.0.1/",
      isDetached: () => false,
      parentFrame: () => null,
      title: async () => "Hello page",
      evaluate: async (fn: (...args: never[]) => unknown, ...args: never[]) => {
        if (typeof fn !== "function") {
          return args[0];
        }
        return fn(...args);
      },
      $eval: async (_selector: string, fn: (element: unknown, options?: unknown) => unknown, options?: unknown) => {
        const target = (globalThis as { document: { body: unknown } }).document.body;
        return fn(target, options);
      },
      $: async () => null,
    };
    const state = {
      id: "page-1",
      page,
      disposed: false,
      lifecycleGeneration: 0,
      refs: new Map(),
      domRevision: 3,
      networkEnabled: false,
      consoleEnabled: false,
      network: [],
      console: [],
      dialogs: [],
      listenersInstalled: true,
      timeoutsConfigured: true,
      viewportConfigured: true,
      downloadConfigured: true,
      navigationGuardInstalled: true,
      stealthInjected: true,
      navigationGeneration: 0,
      policyVerifiedUrls: new Set(["http://127.0.0.1/"]),
      blockedResourceTypes: new Set(),
    };
    const internal = instance as unknown as {
      snapshotUnlocked(options?: object): Promise<{ text: string; interactive: Array<{ selector?: string; valuePresent?: boolean }>; headings: string[] }>;
      executeOnPage(action: BrowserAction): Promise<unknown>;
      pageState(): Promise<unknown>;
      configurePage(): Promise<void>;
      assertCurrentPageAllowed(): Promise<void>;
      assertSnapshotForAction(): void;
      frameFor(): Promise<unknown>;
      selectorFor(_state: unknown, target: string): Promise<string>;
      assertNoPendingDialog(): void;
      states: Map<string, unknown>;
    };
    internal.states.set("page-1", state);
    internal.pageState = async () => state;
    internal.configurePage = async () => undefined;
    internal.assertCurrentPageAllowed = async () => undefined;
    internal.assertSnapshotForAction = () => undefined;
    internal.frameFor = async () => frame;
    internal.selectorFor = async (_state, target) => target;
    internal.assertNoPendingDialog = () => undefined;
    try {
      const snapshot = await internal.snapshotUnlocked({ maxChars: 8_000 });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("private-textarea-default-42");
      expect(serialized).not.toContain("private-script-source-42");
      expect(snapshot.headings.some((heading) => heading.includes("Hello page"))).toBe(true);
      expect(snapshot.interactive.some((element) => element.selector === "#action-button")).toBe(true);
      const extracted = await internal.executeOnPage({ action: "extract", maxChars: 8_000 } as BrowserAction);
      expect(JSON.stringify(extracted)).not.toContain("private-script-source-42");
      const html = await internal.executeOnPage({ action: "get_html", selector: "body", maxChars: 8_000 } as BrowserAction);
      expect(JSON.stringify(html)).not.toContain("private-script-source-42");
      await internal.executeOnPage({ action: "extract", selector: "#action-button", includeLinks: true, maxChars: 2_000 } as BrowserAction);
      await internal.executeOnPage({ action: "search_page", query: "Hello" } as BrowserAction);
      await internal.executeOnPage({ action: "page_next", offset: 0, revision: state.domRevision, maxChars: 4_000 } as BrowserAction);
      await internal.executeOnPage({ action: "find_elements", selector: "button" } as BrowserAction).catch(() => undefined);
      await internal.executeOnPage({ action: "inspect_element", selector: "#action-button", maxDepth: 1, maxChildren: 10 } as BrowserAction).catch(() => undefined);
      await internal.executeOnPage({ action: "get_computed_style", selector: "#action-button" } as BrowserAction);
      await internal.executeOnPage({ action: "get_html", maxChars: 4_000 } as BrowserAction);
    } finally {
      await instance.close();
    }
  });
});
