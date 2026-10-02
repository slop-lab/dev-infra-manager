#!/usr/bin/env node
import { spawn } from "node:child_process";
import { configuredCli, queryCliVersion, validateConfiguredCli } from "./install.js";
import { interactiveInstall, installerCommand } from "./installerCommands.js";
import { printFacadeHelp } from "./installerHelp.js";
import { installerVersion } from "./installerVersion.js";

const args = process.argv.slice(2);

try {
  process.exitCode = await dispatch(args);
} catch (error) {
  console.error(`dim: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function dispatch(commandArgs: string[]): Promise<number> {
  if (process.platform !== "linux") {
    throw new Error(`DIM requires a Linux host; unsupported platform '${process.platform}'`);
  }
  const first = commandArgs[0];
  if (first === "installer") {
    await installerCommand(commandArgs.slice(1));
    return 0;
  }

  const cli = await configuredCli();
  if (cli === undefined) {
    if (first === undefined) {
      await interactiveInstall();
      return 0;
    }
    if (isHelp(first)) {
      printFacadeHelp();
      return 0;
    }
    if (isVersion(first)) {
      console.log(`DIM installer ${await installerVersion()}`);
      console.log("DIM CLI: not installed");
      return 0;
    }
    console.error("dim: DIM CLI is not installed; run 'dim installer install core'");
    return 2;
  }

  const executable = await validateConfiguredCli(cli, process.argv[1]);
  if (isVersion(first)) {
    const installedVersion = await queryCliVersion(executable);
    console.log(`DIM CLI ${installedVersion} (via DIM installer ${await installerVersion()})`);
    if (installedVersion !== cli.version) {
      console.error(
        `dim: warning: configured version ${cli.version} does not match installed ${installedVersion}; run 'dim installer install core' to repair`
      );
    }
    return 0;
  }
  return proxyCli(executable, commandArgs, await installerVersion());
}

async function proxyCli(executable: string, commandArgs: string[], version: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DIM_INVOKED_VIA_INSTALLER: "1",
        DIM_INSTALLER_VERSION: version
      },
      stdio: "inherit"
    });
    const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of forwardedSignals) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

function isVersion(value: string | undefined): boolean {
  return value === "--version" || value === "-V";
}
