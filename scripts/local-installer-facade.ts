import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInstallCommand } from "./local-uninstall/command.ts";
import type { installPlugins } from "../packages/installer/src/pluginInstall.js";

export type SelectedPluginInstaller = typeof installPlugins;

async function selectedInstallerModule(env: NodeJS.ProcessEnv): Promise<string> {
  if (!env.DIM_LOCAL_INSTALLER) throw new Error("matching local installer facade is required");
  return new URL("./pluginInstall.js", pathToFileURL(await realpath(env.DIM_LOCAL_INSTALLER))).href;
}

export async function selectedInstallerPluginInstall(env: NodeJS.ProcessEnv): Promise<SelectedPluginInstaller> {
  const selected: unknown = await import(await selectedInstallerModule(env));
  if (!hasInstaller(selected)) throw new Error("matching local installer does not export plugin installation");
  return selected.installPlugins;
}

function hasInstaller(value: unknown): value is { readonly installPlugins: SelectedPluginInstaller } {
  return value !== null && typeof value === "object" && "installPlugins" in value && typeof value.installPlugins === "function";
}

/** Run npm and any detached installer children inside the bounded local install operation. */
export async function installSelectedPlugins(
  env: NodeJS.ProcessEnv, packages: readonly string[],
  options: Pick<Parameters<SelectedPluginInstaller>[1], "pluginHome" | "pluginNames" | "packageSpecifiers" | "restartController">
): Promise<void> {
  const entry = await selectedInstallerModule(env);
  const script = `const owner = await import(${JSON.stringify(entry)});
    if (typeof owner.installPlugins !== "function") throw new Error("matching local installer does not export plugin installation");
    await owner.installPlugins(${JSON.stringify(packages)}, ${JSON.stringify(options)});`;
  const result = await createInstallCommand(env)(process.execPath, ["--input-type=module", "--eval", script]);
  if (result.status !== 0) throw new Error(`matching local plugin installation failed (${result.status}): ${result.stderr.trim().slice(0, 1000)}`);
}
