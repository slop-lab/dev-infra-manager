#!/usr/bin/env node
import path from "node:path";
import { defaultPluginHome, installPlugins } from "./install.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

let home = defaultPluginHome();
const specifiers: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--plugin-home") {
    const value = args[index + 1];
    if (!value) throw new Error("--plugin-home requires a path");
    home = path.resolve(value);
    index += 1;
  } else if (arg.startsWith("-")) {
    throw new Error(`unknown option: ${arg}`);
  } else {
    specifiers.push(arg);
  }
}

if (specifiers.length === 0) {
  printHelp();
  process.exitCode = 1;
} else {
  const installed = await installPlugins(specifiers, { pluginHome: home });
  for (const name of installed) console.log(`Installed and enabled ${name}`);
  console.log(`Plugin home: ${home}`);
}

function printHelp(): void {
  console.log(`Usage:
  npx "@slop-lab/install-dim@EXACT_VERSION" PACKAGE@EXACT_VERSION [PACKAGE@EXACT_VERSION...]

Options:
  --plugin-home PATH  Override DIM_PLUGIN_HOME

Examples:
  npx "@slop-lab/install-dim@0.1.0" "@dev-infra-manager/plugin-github@1.2.3"
  npx "@slop-lab/install-dim@0.1.0" "@company/internal-git@1.2.3"
  npx "@slop-lab/install-dim@0.1.0" "dim-plugin-local@1.2.3"`);
}
