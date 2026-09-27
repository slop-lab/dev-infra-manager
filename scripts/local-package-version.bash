#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "Usage: bash scripts/local-package-version.bash PACKAGE_DIRECTORY" >&2
  exit 2
fi

node - "$1/packages.json" <<'NODE'
const fs = require("node:fs");

const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
  throw new Error(`invalid local package bundle manifest: ${manifestPath}`);
}
const versions = new Set(manifest.packages.map((entry) => entry.version));
const cli = manifest.packages.find((entry) => entry.name === "@slop-lab/dim-cli");
if (cli === undefined || typeof cli.version !== "string" || versions.size !== 1) {
  throw new Error("local package bundle must contain one shared @slop-lab/dim-cli package version");
}
if (cli.version === "latest" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(cli.version)) {
  throw new Error(`local package version is not a valid immutable workspace image tag: ${cli.version}`);
}
process.stdout.write(`${cli.version}\n`);
NODE
