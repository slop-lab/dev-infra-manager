#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  configuredCli,
  configuredPluginHome,
  defaultBinDirectory,
  installDimCli,
  installPlugins,
  queryCliVersion,
  validateConfiguredCli
} from "./install.js";
import { localBinPrompt } from "./installMode.js";

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
    if (commandArgs.length === 1) await interactiveInstall();
    else if (isHelp(commandArgs[1])) printInstallerHelp();
    else throw new Error(`unknown installer argument: ${commandArgs[1]}`);
    return 0;
  }
  if (first === "install-cli") {
    await installCliCommand(commandArgs.slice(1));
    return 0;
  }
  if (first === "install-plugin") {
    await installPluginCommand(commandArgs.slice(1));
    return 0;
  }

  const cli = await configuredCli();
  if (cli === undefined) {
    // Bare `dim` only opens the interactive installer when there is nothing
    // installed yet to fall back to; once a CLI is configured, bare `dim`
    // instead proxies below like any other command (matching `dim --help`).
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
    console.error(`dim: DIM CLI is not installed; run 'dim install-cli'`);
    return 2;
  }

  const executable = await validateConfiguredCli(cli, process.argv[1]);
  if (isVersion(first)) {
    const installedVersion = await queryCliVersion(executable);
    console.log(`DIM CLI ${installedVersion} (via DIM installer ${await installerVersion()})`);
    if (installedVersion !== cli.version) {
      console.error(
        `dim: warning: configured version ${cli.version} does not match installed ${installedVersion}; run 'dim install-cli' to repair`
      );
    }
    return 0;
  }
  return proxyCli(executable, commandArgs, await installerVersion());
}

async function interactiveInstall(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    printFacadeHelp();
    throw new Error("interactive installation requires a TTY; use install-cli or install-plugin");
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`What would you like to install?
  1) DIM CLI
  2) DIM plugin
  3) DIM CLI and plugin
  q) Cancel`);
    const choice = (await prompt.question("Selection [1]: ")).trim() || "1";
    if (choice === "q" || choice === "quit") return;
    if (!["1", "2", "3"].includes(choice)) throw new Error(`invalid selection: ${choice}`);

    if (choice === "1" || choice === "3") {
      const noLocalBin = runningUnderMise();
      if (noLocalBin) {
        console.warn(`Warning: exposing ~/.local/bin/dim can shadow the mise-managed dim, depending on PATH order.
The symlink runs the CLI directly, bypassing the installer facade and mise version selection.
Installer commands may then require an explicit pinned npx invocation. Keeping DIM managed by mise is recommended.`);
      }
      const localBin = localBinPrompt(noLocalBin);
      const mode = await prompt.question(localBin.question);
      await installCli(localBin.exposeOnPath(mode), defaultBinDirectory());
    }

    if (choice === "2" || choice === "3") {
      const defaultHome = await configuredPluginHome();
      const homeInput = (await prompt.question(`Plugin home [${defaultHome}]: `)).trim();
      const specifierInput = (await prompt.question(
        "Plugin package(s), space-separated and pinned to exact versions (e.g. @scope/pkg@1.2.3): "
      )).trim();
      const specifiers = specifierInput.split(/\s+/).filter(Boolean);
      if (specifiers.length === 0) throw new Error("at least one plugin package is required");
      await installPluginPackages(specifiers, path.resolve(homeInput || defaultHome));
    }
  } finally {
    prompt.close();
  }
}

async function installCliCommand(commandArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: commandArgs,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "no-local-bin": { type: "boolean" },
      "local-bin": { type: "boolean" },
      prefix: { type: "string" }
    }
  });
  if (parsed.values.help) {
    printInstallCliHelp();
    return;
  }
  if (parsed.values["no-local-bin"] && parsed.values["local-bin"]) {
    throw new Error("--no-local-bin and --local-bin cannot be used together");
  }

  const exposeOnPath = parsed.values["local-bin"]
    ? true
    : parsed.values["no-local-bin"]
      ? false
      : !runningUnderMise();
  const binDirectory = parsed.values.prefix
    ? path.join(path.resolve(parsed.values.prefix), "bin")
    : defaultBinDirectory();
  await installCli(exposeOnPath, binDirectory);
}

async function installCli(exposeOnPath: boolean, binDirectory: string): Promise<void> {
  const version = await installerVersion();
  const installed = await installDimCli({ version, exposeOnPath, binDirectory });
  console.log(`Installed DIM CLI ${version} at ${installed.executable}`);
  if (installed.symlink) {
    console.log(`Linked ${installed.symlink} -> ${installed.executable}`);
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry));
    const symlinkDirectory = path.dirname(installed.symlink);
    if (!pathEntries.includes(path.resolve(symlinkDirectory))) {
      console.warn(`Warning: ${symlinkDirectory} is not in PATH; add it, e.g. export PATH="${symlinkDirectory}:$PATH"`);
    }
  } else {
    console.log("DIM CLI will be invoked through the installer facade; no local bin symlink was created");
  }
}

async function installPluginCommand(commandArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: commandArgs,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "plugin-home": { type: "string" }
    }
  });
  if (parsed.values.help) {
    printInstallPluginHelp();
    return;
  }
  if (parsed.positionals.length === 0) throw new Error("install-plugin requires at least one package");
  const home = path.resolve(parsed.values["plugin-home"] ?? await configuredPluginHome());
  await installPluginPackages(parsed.positionals, home);
}

async function installPluginPackages(specifiers: string[], home: string): Promise<void> {
  const installed = await installPlugins(specifiers, { pluginHome: home });
  for (const name of installed) console.log(`Installed and enabled ${name}`);
  console.log(`Plugin home: ${home}`);
  if (await configuredCli() === undefined) {
    console.warn("Warning: DIM CLI is not installed yet; install it before using this plugin");
  }
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

async function installerVersion(): Promise<string> {
  for (const relative of ["./package.json", "../package.json"]) {
    try {
      const manifest = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8")) as { version?: string };
      if (manifest.version) return manifest.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("could not determine @slop-lab/dim-installer version");
}

function runningUnderMise(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DIM_INVOKED_VIA_MISE === "1") return true;
  if (Object.keys(env).some((name) => name.startsWith("MISE_"))) return true;
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.split(path.sep).includes("mise");
}

function isHelp(value: string | undefined): boolean {
  return value === "--help" || value === "-h";
}

function isVersion(value: string | undefined): boolean {
  return value === "--version" || value === "-V";
}

function printFacadeHelp(): void {
  console.log(`DIM installer/facade

DIM CLI is not installed.

Usage:
  dim                         Open the interactive installer
  dim installer               Open the interactive installer
  dim install-cli [options]   Install DIM CLI
  dim install-plugin [options] PACKAGE@EXACT_VERSION...

Run 'dim install-cli --help' for installation modes.`);
}

function printInstallerHelp(): void {
  console.log(`Usage:
  dim installer
  dim install-cli [--no-local-bin | --local-bin] [--prefix PATH]
  dim install-plugin [--plugin-home PATH] PACKAGE@EXACT_VERSION...

The installer owns only installer, install-cli, and install-plugin.
All other commands are forwarded unchanged to the installed DIM CLI.`);
}

function printInstallCliHelp(): void {
  console.log(`Usage: dim install-cli [options]

Options:
  --no-local-bin  Install privately for facade use without ~/.local/bin/dim
  --local-bin     Create a managed dim symlink in the user bin directory
  --prefix PATH   Use PATH/bin for the managed symlink (default: ~/.local)
  -h, --help      Show this help

Under mise, --no-local-bin is the default. Elsewhere, --local-bin is the default.
Using --local-bin under mise may shadow its dim shim, bypass the installer facade,
and make mise version selection differ from the CLI that actually runs.`);
}

function printInstallPluginHelp(): void {
  console.log(`Usage: dim install-plugin [options] PACKAGE@EXACT_VERSION...

Options:
  --plugin-home PATH  Override the plugin installation directory
  -h, --help          Show this help`);
}
