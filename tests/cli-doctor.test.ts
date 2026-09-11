import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { HELP, commandName, printHelp, printVersion, runDoctor, serverArgs, writeCliError } from "@/server/cli";
import { main } from "@/server/main";

function collectStream(): { stream: Writable; output: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return { stream, output: () => Buffer.concat(chunks).toString("utf8") };
}

describe("CLI doctor and help", () => {
  it("advertises server, install --yes, and doctor", () => {
    expect(HELP).toContain("smooth-operator [server]");
    expect(HELP).toContain("install [harness] --yes");
    expect(HELP).toContain("doctor");
    expect(commandName(["doctor"])).toBe("doctor");
    expect(commandName(["server", "--transport", "stdio"])).toBe("server");
    expect(commandName(["install", "opencode", "--yes"])).toBe("install");
    expect(commandName(["--version"])).toBe("version");
    expect(commandName(["-V"])).toBe("version");
    expect(commandName(["--help"])).toBe("help");
    expect(commandName(["-h"])).toBe("help");
    expect(commandName(["--transport", "http"])).toBe("server");
    expect(serverArgs(["server", "--transport", "http"])).toEqual(["--transport", "http"]);
    const help = collectStream();
    printHelp(help.stream);
    expect(help.output()).toContain("doctor");
    const version = collectStream();
    printVersion(version.stream);
    expect(version.output()).toMatch(/^\d+\.\d+\.\d+\n$/);
    const errors = collectStream();
    writeCliError(new Error("boom"), errors.stream);
    expect(JSON.parse(errors.output())).toMatchObject({ level: "error", code: "INTERNAL_ERROR" });
  });

  it("prints executable, profile, and endpoint diagnostics twice", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-doctor-"));
    const previous = {
      SMOOTH_OPERATOR_BROWSER_MODE: process.env.SMOOTH_OPERATOR_BROWSER_MODE,
      SMOOTH_OPERATOR_DATA_DIR: process.env.SMOOTH_OPERATOR_DATA_DIR,
      SMOOTH_OPERATOR_LOG_LEVEL: process.env.SMOOTH_OPERATOR_LOG_LEVEL,
      SMOOTH_OPERATOR_CONFIG: process.env.SMOOTH_OPERATOR_CONFIG,
    };
    process.env.SMOOTH_OPERATOR_BROWSER_MODE = "disabled";
    process.env.SMOOTH_OPERATOR_DATA_DIR = dataDir;
    process.env.SMOOTH_OPERATOR_LOG_LEVEL = "error";
    delete process.env.SMOOTH_OPERATOR_CONFIG;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const captured = collectStream();
        await runDoctor(["doctor"], { stdout: captured.stream });
        const payload = JSON.parse(captured.output()) as {
          command?: string;
          doctor?: { mode?: string; executable?: { source?: string; ready?: boolean }; endpoint?: { state?: string } };
          checks?: { browser?: { status?: string } };
        };
        expect(payload.command).toBe("doctor");
        expect(payload.doctor?.mode).toBe("disabled");
        expect(payload.doctor?.executable?.source).toMatch(/^(configured|discovered|missing)$/);
        expect(typeof payload.doctor?.executable?.ready).toBe("boolean");
        expect(payload.doctor?.endpoint?.state).toBeDefined();
        expect(payload.checks?.browser?.status).toBe("disabled");
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("routes main() to doctor without starting an MCP transport", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "smooth-operator-doctor-main-"));
    const previous = {
      SMOOTH_OPERATOR_BROWSER_MODE: process.env.SMOOTH_OPERATOR_BROWSER_MODE,
      SMOOTH_OPERATOR_DATA_DIR: process.env.SMOOTH_OPERATOR_DATA_DIR,
      SMOOTH_OPERATOR_LOG_LEVEL: process.env.SMOOTH_OPERATOR_LOG_LEVEL,
      SMOOTH_OPERATOR_CONFIG: process.env.SMOOTH_OPERATOR_CONFIG,
    };
    process.env.SMOOTH_OPERATOR_BROWSER_MODE = "disabled";
    process.env.SMOOTH_OPERATOR_DATA_DIR = dataDir;
    process.env.SMOOTH_OPERATOR_LOG_LEVEL = "error";
    delete process.env.SMOOTH_OPERATOR_CONFIG;
    const stdout = collectStream();
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = stdout.stream.write.bind(stdout.stream) as typeof process.stdout.write;
    try {
      await main(["doctor"]);
      const payload = JSON.parse(stdout.output()) as { command?: string; doctor?: { mode?: string } };
      expect(payload.command).toBe("doctor");
      expect(payload.doctor?.mode).toBe("disabled");
    } finally {
      process.stdout.write = originalWrite;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
