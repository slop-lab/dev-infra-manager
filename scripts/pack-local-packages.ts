import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const packageDirectories = [
  "packages/host/core/dist",
  "packages/control-plane/core/dist",
  "packages/contracts/ci/dist",
  "packages/contracts/git/dist",
  "packages/review-tracing/dist",
  "packages/review-tracing-node/dist",
  "packages/task-scheduling/dist",
  "packages/host/plugins/review-tracing-node/dist",
  "packages/control-plane/plugins/review-tracing-scheduled/dist",
  "packages/control-plane/plugins/review-tracing/dist",
  "packages/control-plane/plugins/review-tracing-node/dist",
  "packages/control-plane/admin/dist",
  "packages/control-plane/plugins/ci/dist",
  "packages/host/plugins/native-git/dist",
  "packages/host/plugins/ci-worker/dist",
  "packages/control-plane/plugins/git-repositories/dist",
  "packages/control-plane/plugins/code-review/dist",
  "packages/control-plane/plugins/merge-policy/dist",
  "packages/control-plane/plugins/git-ci/dist",
  "packages/control-plane/plugins/webhooks/dist",
  "packages/web/dist",
  "packages/control-plane/plugins/ci-workflows/dist",
  "packages/contracts/external-url/dist",
  "packages/host/plugins/dns-cloudflare/dist",
  "packages/host/plugins/external-urls/dist",
  "packages/host/plugins/mirrors/dist",
  "packages/host/plugins/cache-server/dist",
  "packages/host/plugins/llm-router/dist",
  "packages/control-plane/plugins/llm-router/dist",
  "packages/host/plugins/vm/dist",
  "packages/host/plugins/kvm/dist",
  "packages/host/plugins/workspace-check/dist",
  "packages/host/plugins/agent-tools/dist",
  "packages/host/plugins/tunnels/dist",
  "packages/cli/dist",
  "packages/installer/dist",
];

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("expected a nonempty JSON string");
  return value;
}

function dependencies(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value ?? {})).map(([name, version]) => [name, string(version)]));
}

/** One manifest graph for source builds and repository verification bundles. */
export function packLocalPackages(workspaceRoot: string, outputDirectory: string) {
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
    const requires: Record<string, string> = {};
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
