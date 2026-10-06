import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  configuredCli,
  defaultBinDirectory,
  defaultPluginHome,
  installDimCli,
  installPlugins,
  isPluginEnabled,
  queryCliVersion,
  readLocalPackageBundle,
  removePlugins,
  setPluginsEnabled,
  validateConfiguredCli
} from "./install.js";
import { localBinPrompt } from "./installMode.js";
import { printFacadeHelp, printInstallCoreHelp, printInstallerHelp, printInstallPluginHelp } from "./installerHelp.js";
import { installerVersion } from "./installerVersion.js";
import { withInstallerProgress } from "./installProgress.js";
import { installControlPlaneCommand } from "./controlPlaneCommand.js";

const HOST_MIRROR_PLUGIN = "@slop-lab/dim-plugin-host-mirrors";

export async function installerCommand(input: readonly string[]): Promise<void> {
  let commandArgs = input;
  while (commandArgs[0] === "installer") commandArgs = commandArgs.slice(1);
  const command = commandArgs[0];
  if (command === undefined) return interactiveInstall();
  if (isHelp(command)) return printInstallerHelp();
  if (command === "install") {
    const target = commandArgs[1];
    if (target === "core") return installCoreCommand(commandArgs.slice(2));
    if (target === "control-plane") return installControlPlaneCommand(commandArgs.slice(2));
    if (target === "plugin") return installPluginCommand(commandArgs.slice(2));
    throw new Error(`unknown installer install target: ${target ?? "missing"}`);
  }
  if (command === "enable-plugin" || command === "disable-plugin" || command === "remove-plugin") {
    return pluginLifecycleCommand(command, commandArgs.slice(1));
  }
  throw new Error(`unknown installer command: ${command}`);
}

export async function interactiveInstall(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    printFacadeHelp();
    throw new Error("interactive installation requires a TTY; use 'dim installer install core' or 'dim installer install plugin'");
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
      await installCore(
        localBin.exposeOnPath(await prompt.question(localBin.question)),
        defaultBinDirectory(),
        (question) => prompt.question(question)
      );
    }
    if (choice === "2" || choice === "3") {
      const input = (await prompt.question("Plugin package(s), space-separated and pinned to exact versions: ")).trim();
      const specifiers = input.split(/\s+/).filter(Boolean);
      if (specifiers.length === 0) throw new Error("at least one plugin package is required");
      await installPluginPackages(specifiers);
    }
  } finally {
    prompt.close();
  }
}

async function installCoreCommand(commandArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args: commandArgs,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "no-local-bin": { type: "boolean" },
      "local-bin": { type: "boolean" },
      "local-packages": { type: "string" },
      "defer-controller-restart": { type: "boolean" },
      "host-mirror-plugin": { type: "string" },
      prefix: { type: "string" }
    }
  });
  if (parsed.values.help) return printInstallCoreHelp();
  if (parsed.values["no-local-bin"] && parsed.values["local-bin"]) {
    throw new Error("--no-local-bin and --local-bin cannot be used together");
  }
  const exposeOnPath = parsed.values["local-bin"] ? true : parsed.values["no-local-bin"] ? false : !runningUnderMise();
  const binDirectory = parsed.values.prefix
    ? path.join(path.resolve(parsed.values.prefix), "bin")
    : defaultBinDirectory();
  const bundle = parsed.values["local-packages"]
    ? await readLocalPackageBundle(parsed.values["local-packages"])
    : undefined;
  if (parsed.values["defer-controller-restart"] && bundle === undefined) {
    throw new Error("--defer-controller-restart requires --local-packages");
  }
  if (bundle !== undefined && parsed.values["host-mirror-plugin"] !== undefined) {
    throw new Error("--host-mirror-plugin cannot be used with --local-packages");
  }
  const version = await installerVersion();
  const plugins = bundle === undefined
    ? await selectHostMirrorPlugin(
      version,
      parsed.values["host-mirror-plugin"],
      stdin.isTTY && stdout.isTTY ? promptHostMirrorPlugin : undefined
    )
    : [];
  const installed = bundle === undefined
    ? await withInstallerProgress("core", async (operation) => installDimCli({
      version, exposeOnPath, binDirectory, operation, plugins
    }))
    : await withInstallerProgress("core", (operation) => installDimCli({
      ...bundle, exposeOnPath, binDirectory, operation,
      restartController: parsed.values["defer-controller-restart"] !== true
    }));
  console.log(`${bundle ? "Installed local" : "Installed"} DIM CLI ${installed.version} at ${installed.executable}`);
  if (installed.symlink) console.log(`Linked ${installed.symlink} -> ${installed.executable}`);
  else console.log("DIM CLI will be invoked through the installer facade; no local bin symlink was created");
}

async function installCore(
  exposeOnPath: boolean,
  binDirectory: string,
  question: (text: string) => Promise<string>
): Promise<void> {
  const version = await installerVersion();
  const plugins = await selectHostMirrorPlugin(version, undefined, question);
  const installed = await withInstallerProgress("core", (operation) =>
    installDimCli({ version, exposeOnPath, binDirectory, operation, plugins }));
  console.log(`Installed DIM CLI ${version} at ${installed.executable}`);
  if (!installed.symlink) {
    console.log("DIM CLI will be invoked through the installer facade; no local bin symlink was created");
    return;
  }
  console.log(`Linked ${installed.symlink} -> ${installed.executable}`);
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry));
  const symlinkDirectory = path.dirname(installed.symlink);
  if (!pathEntries.includes(path.resolve(symlinkDirectory))) {
    console.warn(`Warning: ${symlinkDirectory} is not in PATH; add it, e.g. export PATH="${symlinkDirectory}:$PATH"`);
  }
}

async function selectHostMirrorPlugin(
  version: string,
  supplied: string | undefined,
  question: ((text: string) => Promise<string>) | undefined
): Promise<readonly { readonly name: string; readonly specifier: string }[]> {
  const expected = `${HOST_MIRROR_PLUGIN}@${version}`;
  if (supplied !== undefined && supplied !== expected) {
    throw new Error(`--host-mirror-plugin must be the reviewed package '${expected}'`);
  }
  const enabled = await isPluginEnabled(HOST_MIRROR_PLUGIN, defaultPluginHome());
  if (supplied === undefined && !enabled) {
    if (question === undefined) {
      throw new Error(
        `the required host mirror provider is not enabled; retry with --host-mirror-plugin '${expected}'`
      );
    }
    const answer = (await question(
      `Install and enable the required reviewed host plugin ${expected}? [Y/n] `
    )).trim().toLowerCase();
    if (answer !== "" && answer !== "y" && answer !== "yes") {
      throw new Error(`the required host mirror provider was declined; no DIM runtime was installed`);
    }
  }
  return [{ name: HOST_MIRROR_PLUGIN, specifier: expected }];
}

async function promptHostMirrorPlugin(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function installPluginCommand(commandArgs: readonly string[]): Promise<void> {
  const parsed = parseArgs({ args: commandArgs, allowPositionals: true, strict: true, options: { help: { type: "boolean", short: "h" } } });
  if (parsed.values.help) return printInstallPluginHelp();
  if (parsed.positionals.length === 0) throw new Error("installer install plugin requires at least one package");
  await installPluginPackages(parsed.positionals);
}

async function installPluginPackages(specifiers: readonly string[]): Promise<void> {
  const cli = await configuredCli();
  if (cli === undefined) {
    throw new Error("DIM CLI must be installed before plugins so npm can validate the shared runtime");
  }
  const executable = await validateConfiguredCli(cli, process.argv[1]);
  const installedVersion = await queryCliVersion(executable);
  if (installedVersion !== cli.version) {
    throw new Error(`configured version ${cli.version} does not match installed ${installedVersion}; run 'dim installer install core' to repair`);
  }
  const home = defaultPluginHome();
  const installed = await withInstallerProgress("plugin", (operation) =>
    installPlugins(specifiers, { pluginHome: home, operation }));
  for (const name of installed) console.log(`Installed and enabled ${name}`);
  console.log(`Plugin home: ${home}`);
}

async function pluginLifecycleCommand(
  command: "enable-plugin" | "disable-plugin" | "remove-plugin",
  commandArgs: readonly string[]
): Promise<void> {
  const parsed = parseArgs({ args: commandArgs, allowPositionals: true, strict: true, options: { help: { type: "boolean", short: "h" } } });
  if (parsed.values.help) return console.log(`Usage: dim installer ${command} PACKAGE...`);
  if (parsed.positionals.length === 0) throw new Error(`${command} requires at least one package`);
  if (await configuredCli() === undefined) throw new Error("DIM CLI is not installed");
  const options = { pluginHome: defaultPluginHome() };
  if (command === "remove-plugin") await removePlugins(parsed.positionals, options);
  else await setPluginsEnabled(parsed.positionals, command === "enable-plugin", options);
  for (const name of parsed.positionals) {
    console.log(`${command === "enable-plugin" ? "Enabled" : command === "disable-plugin" ? "Disabled" : "Removed"} ${name}`);
  }
}

function runningUnderMise(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DIM_INVOKED_VIA_MISE === "1") return true;
  if (Object.keys(env).some((name) => name.startsWith("MISE_"))) return true;
  return (process.argv[1] ?? "").split(path.sep).includes("mise");
}

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}
