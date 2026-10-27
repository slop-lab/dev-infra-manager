#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { configuredCli, hostExecutable } from "./installConfig.js";
import { queryCliVersion, validateConfiguredCli } from "./cliExecutable.js";
import { installerVersion } from "./installerVersion.js";

const args = process.argv.slice(2);

try {
  process.exitCode = await dispatch(args);
} catch (error) {
  const { ControlPlaneInstallError, formatControlPlaneInstallError } = await import("./controlPlaneInstallError.js");
  if (error instanceof ControlPlaneInstallError) {
    for (const line of formatControlPlaneInstallError(error)) console.error(`dim: ${line}`);
  } else {
    console.error(`dim: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}

async function dispatch(commandArgs: string[]): Promise<number> {
  if (process.platform !== "linux") {
    throw new Error(`DIM requires a Linux host; unsupported platform '${process.platform}'`);
  }
  const first = commandArgs[0];
  if (first === "installer") {
    const { installerCommand } = await import("./installerCommands.js");
    await installerCommand(commandArgs.slice(1));
    return 0;
  }
  if (first === "install-cp") {
    console.error("dim: 'install-cp' is obsolete; use 'dim installer install control-plane --config FILE'");
    return 2;
  }

  if (first === "__host") return proxyCli(hostExecutable(), commandArgs, await installerVersion());

  const cli = await configuredCli();
  if (cli === undefined) {
    if (first === undefined) {
      const { interactiveInstall } = await import("./installerCommands.js");
      await interactiveInstall();
      return 0;
    }
    if (isHelp(first)) {
      const { printFacadeHelp } = await import("./installerHelp.js");
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
        `dim: warning: configured version ${cli.version} does not match installed ${installedVersion}; run 'dim installer install cli' to repair`
      );
    }
    return 0;
  }
  return proxyCli(executable, commandArgs, await installerVersion());
}

async function proxyCli(executable: string, commandArgs: string[], version: string): Promise<never> {
  const execve = process.execve;
  if (execve === undefined) throw new Error("DIM requires a Node.js runtime with process replacement support");
  execve(executable, [executable, ...commandArgs], {
    ...process.env,
    DIM_HOST_EXECUTABLE: hostExecutable(),
    DIM_INVOKED_VIA_INSTALLER: "1",
    DIM_INSTALLER_VERSION: version,
    DIM_INSTALLER_ENTRYPOINT: fileURLToPath(import.meta.url)
  });
  throw new Error("process replacement returned unexpectedly");
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

function isVersion(value: string | undefined): boolean {
  return value === "--version" || value === "-V";
}
