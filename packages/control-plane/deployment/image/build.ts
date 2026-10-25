import { resolve } from "node:path";
import { buildServiceImage } from "../../../../scripts/packages/build-service-image.ts";

const root = resolve(import.meta.dirname, "../../../..");
const packages = [
  "control-plane/core", "control-plane/admin", "control-plane/deployment",
  "control-plane/plugins/git-repositories", "control-plane/plugins/git-review",
  "control-plane/plugins/git-merge-policy", "control-plane/plugins/git-ci",
  "control-plane/plugins/git-sync",
  "control-plane/plugins/git-diff", "control-plane/plugins/git-pull-requests",
  "control-plane/plugins/git-discussions", "control-plane/plugins/git-blame",
  "git-tools/diff", "git-tools/pull-requests",
  "control-plane/plugins/webhooks", "control-plane/plugins/ci-workflows",
  "contracts/git", "contracts/ci", "contracts/execution",
  // The managed pair validates scheduler configuration without loading its runtime.
  "control-plane/plugins/execution-scheduler"
];
await buildServiceImage({ imageDirectory: import.meta.dirname,
  packageDirectories: packages.map((directory) => resolve(root, "packages", directory, "dist")) }, process.argv[2] ?? "dim-git-service:local");
