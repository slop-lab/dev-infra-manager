import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { localArtifacts } from "../local-source-runtime.ts";

export async function readExampleArtifacts(bundle: string) {
  const manifest: unknown = JSON.parse(await readFile(join(bundle, "packages.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("packages" in manifest) || !Array.isArray(manifest.packages)) throw new Error("invalid example artifact manifest");
  const names = manifest.packages.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") throw new Error("invalid example artifact name");
    return entry.name;
  });
  const artifacts = localArtifacts(manifest, ["@slop-lab/dim-installer", "@slop-lab/dim-host-core", ...names]);
  if (artifacts.some(({ version }) => !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version))) throw new Error("example artifacts require exact package versions");
  return artifacts;
}

export function examplePluginSpecifiers(artifacts: readonly { readonly name: string; readonly version: string }[], specs: readonly string[]): readonly string[] {
  return specs.map((specifier) => {
    const separator = specifier.lastIndexOf("@"), name = specifier.slice(0, separator), declared = specifier.slice(separator + 1);
    const artifact = artifacts.find((entry) => entry.name === name);
    if (!artifact || (artifact.version !== declared && /^(\d+\.\d+\.\d+)-local-[a-f0-9]{64}$/.exec(artifact.version)?.[1] !== declared)) {
      throw new Error(`recipe pin '${specifier}' does not match the reviewed example bundle`);
    }
    return `${name}@${artifact.version}`;
  });
}
