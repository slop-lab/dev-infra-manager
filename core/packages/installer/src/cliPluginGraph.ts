import path from "node:path";
import { readManifest, readPackageJson, type PluginManifest } from "./runtimeFiles.js";

export interface CliPluginSelection {
  readonly name: string;
  readonly specifier: string;
}

export interface CliPluginGraph {
  readonly manifest: PluginManifest;
  readonly specifiers: readonly string[];
}

export async function prepareCliPluginGraph(
  currentDirectory: string,
  selectedPlugins: readonly CliPluginSelection[],
  packageNames: readonly string[]
): Promise<CliPluginGraph> {
  const previousManifest = await readManifest(path.join(currentDirectory, "plugins.json"));
  const previousPackage = await readPackageJson(path.join(currentDirectory, "package.json"));
  const providedNames = new Set([...packageNames, ...selectedPlugins.map(({ name }) => name)]);
  const previousSpecifiers = previousManifest.plugins
    .filter((name) => !providedNames.has(name))
    .map((name) => {
      const version = previousPackage?.dependencies?.[name];
      if (!version) throw new Error(`enabled plugin '${name}' is not installed in the DIM runtime`);
      return `${name}@${version}`;
    });
  return {
    specifiers: [...selectedPlugins.map(({ specifier }) => specifier), ...previousSpecifiers],
    manifest: {
      schemaVersion: 1,
      plugins: [...new Set([...previousManifest.plugins, ...selectedPlugins.map(({ name }) => name)])].sort()
    }
  };
}

export async function verifySelectedPlugins(
  stagingDirectory: string,
  selectedPlugins: readonly CliPluginSelection[]
): Promise<void> {
  const stagedPackage = await readPackageJson(path.join(stagingDirectory, "package.json"));
  for (const plugin of selectedPlugins) {
    if (!(plugin.name in (stagedPackage?.dependencies ?? {}))) {
      throw new Error(`npm did not install '${plugin.name}' as a direct plugin dependency`);
    }
  }
}
