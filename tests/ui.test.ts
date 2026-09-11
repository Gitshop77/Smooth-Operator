import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createUi } from "@/server/ui";
import { Logger } from "@/server/logger";

function collect(isTTY = false): { stream: Writable & { isTTY?: boolean }; output: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return { stream, output: () => Buffer.concat(chunks).toString("utf8") };
}

describe("installer UI and logger helpers", () => {
  it("renders every helper on a TTY and sanitizes control characters", () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousTerm = process.env.TERM;
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    const captured = collect(true);
    try {
      const ui = createUi(captured.stream);
      expect(ui.colors).toBe(true);
      expect(ui.bold("Name")).toContain("Name");
      expect(ui.dim("hint")).toContain("hint");
      expect(ui.cyan("link")).toContain("link");
      expect(ui.green("ok")).toContain("ok");
      expect(ui.yellow("warn")).toContain("warn");
      expect(ui.red("err")).toContain("err");
      ui.banner("SmoothOperator", "browser MCP", "3.2.0");
      ui.step(1, 3, "Profile");
      ui.explain(["Choose an isolated profile."]);
      ui.option(1, "Managed", "Private profile", true);
      ui.keyValues([["Mode", "managed"]]);
      ui.success("Installed");
      ui.failure("Could not write\nconfig");
      ui.note("Restart the harness");
      const text = captured.output();
      expect(text).toContain("SmoothOperator");
      expect(text).toContain("Installed");
      expect(text).not.toContain("\nconfig");
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previousTerm;
      }
    }
  });

  it("degrades to plain text without a writable TTY", () => {
    const ui = createUi(undefined);
    expect(ui.colors).toBe(false);
    expect(ui.red("plain")).toBe("plain");
    ui.failure("still safe");
  });

  it("covers logger child, debug, and level", () => {
    const lines: string[] = [];
    const logger = new Logger("debug", { component: "test" }, (line) => lines.push(line));
    expect(logger.level).toBe("debug");
    logger.debug("probe", { token: "secret-token-value" });
    logger.child({ request: "1" }).info("ok");
    expect(lines.some((line) => line.includes("probe"))).toBe(true);
    expect(lines.join("")).not.toContain("secret-token-value");
    const stderrLogger = new Logger("debug");
    stderrLogger.debug("default-sink");
    stderrLogger.warn("default-warn");
    stderrLogger.error("default-error");
    expect(stderrLogger.level).toBe("debug");
  });
});
