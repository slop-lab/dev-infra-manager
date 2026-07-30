import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const outputDirectory = process.argv[2];
if (!outputDirectory) {
  throw new Error("output directory is required");
}

const packageDirectories = [
  "packages/core/dist",
  "packages/contracts/external-url/dist",
  "packages/controller-proxy/dist",
  "packages/dns-provider/cloudflare/dist",
  "packages/plugin/external-urls/dist",
  "packages/cli/dist",
  "packages/installer/dist",
];

const packages = packageDirectories.map((directory) => {
  const metadata = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  const packed = spawnSync(
    "pnpm",
    ["--dir", directory, "pack", "--pack-destination", outputDirectory, "--json"],
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

const manifestPath = path.join(outputDirectory, "packages.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
);

console.log(`Packed ${packages.length} packages in ${outputDirectory}`);
console.log(`Manifest: ${manifestPath}`);
