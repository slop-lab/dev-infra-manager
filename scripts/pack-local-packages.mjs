// @ts-check
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageDirectories = [
  "core/packages/core/dist",
  "core/packages/managed/dist",
  "core/packages/native-git/dist",
  "core/packages/web/dist",
  "plugin-ci-workflows/dist",
  "core/packages/contracts/external-url/dist",
  "plugin-dns-cloudflare/dist",
  "plugin-external-urls/dist",
  "plugin-host-mirrors/dist",
  "plugin-cache-server/dist",
  "plugin-llm-router/dist",
  "plugin-vm/dist",
  "plugin-workspace-check/dist",
  "plugin-agent-tools/dist",
  "plugin-tunnels/dist",
  "core/packages/cli/dist",
  "core/packages/installer/dist",
];

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {string} */
function string(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("expected a nonempty JSON string");
  return value;
}

/** @param {unknown} value @returns {Record<string, string>} */
function dependencies(value) {
  return Object.fromEntries(Object.entries(object(value ?? {})).map(([name, version]) => [name, string(version)]));
}

/** One manifest graph for source builds and repository verification bundles.
 * @param {string} workspaceRoot
 * @param {string} outputDirectory
 */
export function packLocalPackages(workspaceRoot, outputDirectory) {
  const candidates = packageDirectories.map((directory) => {
    const absolute = path.resolve(workspaceRoot, directory);
    const value = object(JSON.parse(readFileSync(path.join(absolute, "package.json"), "utf8")));
    const peerMeta = object(value.peerDependenciesMeta ?? {});
    const optionalPeers = new Set(Object.entries(peerMeta).filter(([, entry]) => object(entry).optional === true).map(([name]) => name));
    return { directory: absolute, metadata: {
      name: string(value.name), version: string(value.version),
      dependencies: dependencies(value.dependencies), peerDependencies: dependencies(value.peerDependencies), optionalPeers,
    } };
  });
  const byName = new Map(candidates.map(({ metadata }) => [metadata.name, metadata]));
  const packages = candidates.map(({ directory, metadata }) => {
    /** @type {Record<string, string>} */
    const requires = {};
    const dependencies = { ...metadata.dependencies };
    for (const [name, version] of Object.entries(metadata.peerDependencies ?? {})) {
      if (!metadata.optionalPeers.has(name)) dependencies[name] = version;
    }
    for (const [name, version] of Object.entries(dependencies)) {
      const dependency = byName.get(name);
      if (!dependency) {
        if (name.startsWith("@slop-lab/dim-")) throw new Error(`bundle is missing required DIM package '${name}' for '${metadata.name}'`);
        continue;
      }
      if (version !== dependency.version) throw new Error(`bundle dependency '${metadata.name}' requires '${name}@${version}', but contains '${dependency.version}'`);
      requires[name] = version;
    }
    const packed = spawnSync("pnpm", ["--dir", directory, "pack", "--pack-destination", outputDirectory, "--json"], { encoding: "utf8" });
    if (packed.status !== 0) {
      process.stderr.write(packed.stderr);
      throw new Error(`pnpm pack failed for ${metadata.name}`);
    }
    const filename = string(object(JSON.parse(packed.stdout)).filename);
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
