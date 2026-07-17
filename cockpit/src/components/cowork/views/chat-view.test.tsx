import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Mark the environment as an act() environment so React flushes createRoot
// renders synchronously.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement Element.scrollTo; the scroll-to-bottom effect calls
// it on mount. Provide a no-op stub.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const mutate = vi.fn();
let isPending = false;

vi.mock("@/hooks/use-cowork-query", () => ({
  useSendChat: () => ({ mutate, isPending }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

async function render() {
  const { ChatView } = await import("./chat-view");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ChatView />);
  });
  return { container, root };
}

describe("ChatView composer guard", () => {
  beforeEach(() => {
    mutate.mockReset();
    isPending = false;
  });

  it("disables the composer input and Send button while a request is in flight", async () => {
    isPending = true;
    const { container, root } = await render();

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Message Wingman"]',
    );
    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send"]',
    );

    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();
    expect(input?.disabled ?? false).toBe(true);
    expect(sendButton?.disabled ?? false).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("enables the input (Send stays disabled until text is entered) when idle", async () => {
    isPending = false;
    const { container, root } = await render();

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Message Wingman"]',
    );
    const sendButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send"]',
    );

    expect(input?.disabled ?? true).toBe(false);
    // Send is disabled because the composer is empty, not because of pending.
    expect(sendButton?.disabled ?? true).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
