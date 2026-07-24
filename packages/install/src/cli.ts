#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  configuredPluginHome,
  defaultInstallPrefix,
  installDimCli,
  installPlugins
} from "./install.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
} else if (args.length === 0) {
  await interactiveInstall();
} else if (args[0] === "cli") {
  await installCliCommand(args.slice(1));
} else if (args[0] === "plugin") {
  await installPluginCommand(args.slice(1));
} else {
  throw new Error(`unknown command: ${args[0]}; expected 'cli' or 'plugin'`);
}

async function interactiveInstall(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    printHelp();
    throw new Error("interactive installation requires a TTY; use the cli or plugin command");
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
      const defaultPrefix = defaultInstallPrefix();
      const prefixInput = (await prompt.question(`Install prefix [${defaultPrefix}]: `)).trim();
      await installCli(path.resolve(prefixInput || defaultPrefix));
    }

    if (choice === "2" || choice === "3") {
      const defaultHome = await configuredPluginHome();
      const homeInput = (await prompt.question(`Plugin home [${defaultHome}]: `)).trim();
      const specifierInput = (await prompt.question(
        "Plugin package(s), space-separated and pinned to exact versions: "
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
  let prefix = defaultInstallPrefix();
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--prefix") {
      const value = commandArgs[index + 1];
      if (!value) throw new Error("--prefix requires a path");
      prefix = path.resolve(value);
      index += 1;
    } else {
      throw new Error(arg.startsWith("-") ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
    }
  }

  await installCli(prefix);
}

async function installCli(prefix: string): Promise<void> {
  const version = await installerVersion();
  await installDimCli({ prefix, version });
  console.log(`Installed ${prefix}/bin/dim`);
  console.log(`Ensure ${prefix}/bin is in PATH`);
}

async function installPluginCommand(commandArgs: string[]): Promise<void> {
  let home = await configuredPluginHome();
  const specifiers: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--plugin-home") {
      const value = commandArgs[index + 1];
      if (!value) throw new Error("--plugin-home requires a path");
      home = path.resolve(value);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      specifiers.push(arg);
    }
  }
  if (specifiers.length === 0) throw new Error("plugin requires at least one package");

  await installPluginPackages(specifiers, home);
}

async function installPluginPackages(specifiers: string[], home: string): Promise<void> {
  const installed = await installPlugins(specifiers, { pluginHome: home });
  for (const name of installed) console.log(`Installed and enabled ${name}`);
  console.log(`Plugin home: ${home}`);
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
  throw new Error("could not determine @slop-lab/install-dim version");
}

function printHelp(): void {
  console.log(`Usage:
  npx "@slop-lab/install-dim@EXACT_VERSION"
  npx "@slop-lab/install-dim@EXACT_VERSION" cli [--prefix PATH]
  npx "@slop-lab/install-dim@EXACT_VERSION" plugin PACKAGE@EXACT_VERSION [PACKAGE@EXACT_VERSION...]

Running without arguments opens an interactive installer for DIM, plugins, or both.

Options:
  --prefix PATH       Install DIM under PATH (default: ~/.local)
  --plugin-home PATH  Override DIM_PLUGIN_HOME for the plugin command

Examples:
  npx "@slop-lab/install-dim@0.1.0"
  npx "@slop-lab/install-dim@0.1.0" cli
  npx "@slop-lab/install-dim@0.1.0" cli --prefix "$HOME/.local"
  npx "@slop-lab/install-dim@0.1.0" plugin "@dev-infra-manager/plugin-github@1.2.3"`);
}
