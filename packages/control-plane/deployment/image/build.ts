import { resolve } from "node:path";
import { buildServiceImage } from "../../../../scripts/packages/build-service-image.ts";

const root = resolve(import.meta.dirname, "../../../..");
const packages = [
  "control-plane/core", "control-plane/admin", "control-plane/deployment",
  "control-plane/plugins/git-repositories", "control-plane/plugins/code-review",
  "control-plane/plugins/merge-policy", "control-plane/plugins/git-ci",
  "control-plane/plugins/webhooks", "control-plane/plugins/ci-workflows",
  "contracts/git", "contracts/ci", "contracts/execution",
  // The managed pair validates scheduler configuration without loading its runtime.
  "control-plane/plugins/execution-scheduler"
];
await buildServiceImage({ imageDirectory: import.meta.dirname,
  packageDirectories: packages.map((directory) => resolve(root, "packages", directory, "dist")) }, process.argv[2] ?? "dim-git-service:local");
