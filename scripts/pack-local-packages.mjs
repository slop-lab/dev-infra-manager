import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectories = [
  "core/packages/core/dist",
  "core/packages/managed/dist",
  "core/packages/contracts/external-url/dist",
  "core/packages/controller-proxy/dist",
  "plugin-dns-cloudflare/dist",
  "plugin-external-urls/dist",
  "plugin-host-mirrors/dist",
  "core/packages/cli/dist",
  "core/packages/installer/dist",
];

/** One manifest graph for source builds and repository verification bundles. */
export function packLocalPackages(workspaceRoot, outputDirectory) {
  const candidates = packageDirectories.map((directory) => {
    const absolute = path.resolve(workspaceRoot, directory);
    return { directory: absolute, metadata: JSON.parse(readFileSync(path.join(absolute, "package.json"), "utf8")) };
  });
  const names = new Set(candidates.map(({ metadata }) => metadata.name));
  const packages = candidates.map(({ directory, metadata }) => {
    const requires = {};
    const dependencies = { ...metadata.dependencies };
    for (const [name, version] of Object.entries(metadata.peerDependencies ?? {})) {
      if (metadata.peerDependenciesMeta?.[name]?.optional !== true) dependencies[name] = version;
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (!names.has(name)) {
        if (name.startsWith("@slop-lab/dim-")) throw new Error(`bundle is missing required DIM package '${name}' for '${metadata.name}'`);
        continue;
      }
      const dependency = candidates.find(({ metadata }) => metadata.name === name).metadata;
      if (version !== dependency.version) throw new Error(`bundle dependency '${metadata.name}' requires '${name}@${version}', but contains '${dependency.version}'`);
      requires[name] = version;
    }
    const packed = spawnSync("pnpm", ["--dir", directory, "pack", "--pack-destination", outputDirectory, "--json"], { encoding: "utf8" });
    if (packed.status !== 0) {
      process.stderr.write(packed.stderr);
      throw new Error(`pnpm pack failed for ${metadata.name}`);
    }
    const { filename } = JSON.parse(packed.stdout);
    return { name: metadata.name, version: metadata.version, file: path.basename(filename), requires };
  });
  writeFileSync(path.join(outputDirectory, "packages.json"), `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`);
  return packages;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [, , workspaceRoot, outputDirectory] = process.argv;
  if (!workspaceRoot || !outputDirectory) throw new Error("source root and output directory are required");
  packLocalPackages(workspaceRoot, outputDirectory);
}
