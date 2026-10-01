import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.argv[2];
const outputDirectory = process.argv[3];
if (!workspaceRoot || !outputDirectory) {
  throw new Error("source root and output directory are required");
}
const packageDirectories = [
  "core/packages/core/dist",
  "core/packages/contracts/external-url/dist",
  "core/packages/controller-proxy/dist",
  "plugin-dns-cloudflare/dist",
  "plugin-external-urls/dist",
  "core/packages/cli/dist",
  "core/packages/installer/dist",
];

const packages = packageDirectories.map((directory) => {
  const absoluteDirectory = path.join(workspaceRoot, directory);
  const metadata = JSON.parse(
    readFileSync(path.join(absoluteDirectory, "package.json"), "utf8"),
  );
  const packed = spawnSync(
    "pnpm",
    ["--dir", absoluteDirectory, "pack", "--pack-destination", outputDirectory, "--json"],
    { encoding: "utf8" },
  );
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr);
    throw new Error(`pnpm pack failed for ${metadata.name}`);
  }
  const { filename } = JSON.parse(packed.stdout);
  return {
    name: metadata.name,
    version: metadata.version,
    file: path.basename(filename),
  };
});

writeFileSync(
  path.join(outputDirectory, "packages.json"),
  `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
);
