import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { INSTALL_USAGE, commandName, printHelp, printVersion, runDoctor, serverArgs, writeCliError } from "./cli";
import { loadServerConfig } from "./config";
import { AppError, safeErrorDiagnostic } from "./errors";
import { HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS, observeShutdown, runBoundedShutdownPhase, serveHttp } from "./http";
import { createMcpServer } from "./mcp";
import { ServerRuntime } from "./runtime";
import { installHarness, planHarnessInstall, supportedHarnessTargets } from "./installer";
import { SERVER_VERSION } from "./version";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = commandName(args);
  if (command === "version") {
    printVersion();
    return;
  }
  if (command === "help") {
    if (args[0] === "install") {
      process.stderr.write(`${INSTALL_USAGE}\n`);
      return;
    }
    printHelp();
    return;
  }
  if (command === "doctor") {
    await runDoctor(args);
    return;
  }
  if (args[0] === "install") {
    const yes = args.includes("--yes") || args.includes("--no-interactive");
    const rawTargets = args.slice(1).filter((a) => !a.startsWith("--"));
    let harness = rawTargets[0];
    if (args.includes("--help") || args.includes("-h")) {
      process.stderr.write(`${INSTALL_USAGE}\n`);
      return;
    }
    if (harness === "list") {
      process.stdout.write(`${supportedHarnessTargets().join("\n")}\n`);
      return;
    }
    if (harness && args.filter((a) => !a.startsWith("--") && a !== "install").length > 1) {
      throw new AppError("CONFIG_INVALID", "The install command accepts exactly one harness target.");
    }
    const { isInteractive, promptForHarness, runWizard, persistWizardConfig } = await import("./installer-wizard.js");
    if (!harness && (yes || !isInteractive())) {
      process.stderr.write(`${INSTALL_USAGE}\n`);
      return;
    }
    if (!harness) {
      harness = await promptForHarness({ stdin: process.stdin, stdout: process.stdout });
    }
    if (!harness) {
      throw new AppError("CONFIG_INVALID", "The install command requires a harness target.");
    }
    // Validate the target before touching any configuration so an unknown
    // name cannot leave a half-applied install behind.
    planHarnessInstall(harness, { homeDirectory: homedir(), environment: process.env });
    const wizardChoices = await runWizard(harness, { yes, stdin: process.stdin, stdout: process.stdout, homeDir: homedir(), env: process.env, version: SERVER_VERSION });
    await persistWizardConfig(wizardChoices, homedir());
    const installMessage = await installHarness(harness);
    const { createUi } = await import("./ui");
    const ui = createUi(process.stdout);
    if (process.stdout.isTTY) {
      ui.banner("Installation Complete", `${harness} can now drive a browser`, SERVER_VERSION);
      ui.keyValues([
        ["Config file", `${homedir()}/.smooth-operator/config.json`],
        ["Browser mode", wizardChoices.mode],
      ]);
      process.stdout.write("\n");
      ui.step(0, 2, "Next steps");
      ui.option(1, "Restart the harness", "Quit and reopen it so it picks up the new MCP server.");
      ui.option(2, "Verify", "Ask your AI to run server_health and browser_doctor.");
      ui.success(installMessage);
    } else {
      process.stdout.write(`${installMessage}\n`);
    }
    return;
  }
  const config = loadServerConfig(serverArgs(args));
  const runtime = await ServerRuntime.create(config);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        runtime.logger.info("Shutdown requested", { reason });
        await runtime.close();
      })();
    }
    return shutdownPromise;
  };

  if (config.transport === "http") {
    try {
      await serveHttp(runtime, shutdown);
    } catch (error) {
      await shutdown("HTTP_STARTUP_FAILED");
      throw error;
    }
    return;
  }

  let handle: ReturnType<typeof serveStdio>;
  try {
    handle = serveStdio(() => createMcpServer(runtime), {
      legacy: "serve",
      onerror: (error) => runtime.logger.error("MCP stdio error", safeErrorDiagnostic(error)),
    });
  } catch (error) {
    await shutdown("STDIO_STARTUP_FAILED");
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = async (reason: string): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await runBoundedShutdownPhase("MCP stdio transport close", () => handle.close(), HTTP_HANDLER_SHUTDOWN_TIMEOUT_MS, runtime);
        } finally {
          process.stdin.removeListener("end", onInputClosed);
          process.stdin.removeListener("close", onInputClosed);
          process.stdin.removeListener("error", onInputClosed);
          process.stdout.removeListener("error", onInputClosed);
          await shutdown(reason);
        }
      })();
    }
    return closePromise;
  };
  process.once("SIGINT", () => {
    observeShutdown(close("SIGINT"), runtime);
  });
  process.once("SIGTERM", () => {
    observeShutdown(close("SIGTERM"), runtime);
  });
  const onInputClosed = (): void => {
    observeShutdown(close("STDIO_INPUT_CLOSED"), runtime);
  };
  process.stdin.once("end", onInputClosed);
  process.stdin.once("close", onInputClosed);
  process.stdin.once("error", onInputClosed);
  process.stdout.once("error", onInputClosed);
  runtime.logger.info("MCP stdio server ready");
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    writeCliError(error);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return realpathSync(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
