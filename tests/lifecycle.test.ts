/**
 * lifecycle.ts tests — status dot + lifecycle label updates.
 */

import { describe, test, expect, beforeAll } from "vitest";

function setupDom(): void {
  document.body.innerHTML = `
    <div id="chatMessages"></div>
    <input id="messageInput" />
    <button id="sendBtn"></button>
    <button id="stopBtn"></button>
    <span id="costLabel">$0.0000</span>
    <span id="tokenLabel">0 tokens</span>
    <span id="statusDot" data-status="idle"></span>
    <span id="statusLabel">idle</span>
    <div id="takeoverBanner" hidden></div>
    <div id="takeoverReason"></div>
    <button id="resumeBtn"></button>
  `;
}

describe("lifecycle status updates", () => {
  let setLifecycle: (state: "idle" | "thinking" | "acting" | "waiting" | "done" | "error") => void;

  beforeAll(async () => {
    setupDom();
    const mod = await import("../src/extension/sidepanel/lifecycle");
    setLifecycle = mod.setLifecycle;
  });

  test("sets status dot data-status attribute", () => {
    setLifecycle("thinking");
    const dot = document.getElementById("statusDot") as HTMLElement;
    expect(dot.dataset.status).toBe("thinking");
  });

  test("sets status label text", () => {
    setLifecycle("acting");
    const label = document.getElementById("statusLabel") as HTMLElement;
    expect(label.textContent).toBe("Acting…");
  });

  test("sets idle state", () => {
    setLifecycle("idle");
    const dot = document.getElementById("statusDot") as HTMLElement;
    const label = document.getElementById("statusLabel") as HTMLElement;
    expect(dot.dataset.status).toBe("idle");
    expect(label.textContent).toBe("Ready");
  });

  test("sets error state", () => {
    setLifecycle("error");
    const dot = document.getElementById("statusDot") as HTMLElement;
    const label = document.getElementById("statusLabel") as HTMLElement;
    expect(dot.dataset.status).toBe("error");
    expect(label.textContent).toBe("Error");
  });
});
