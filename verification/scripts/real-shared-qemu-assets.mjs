#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, stateRoot, hookPath, outputPath] = process.argv.slice(2);
if (root === undefined || stateRoot === undefined || hookPath === undefined || outputPath === undefined) {
  process.stderr.write("usage: real-shared-qemu-assets.mjs ROOT STATE_ROOT HOOK_PATH OUTPUT_PATH\n");
  process.exit(2);
}

const importFromDist = async (moduleName) => import(pathToFileURL(resolve(root, "core/packages/core/dist", moduleName)).href);
const [{ ProcessRunner }, imageAssets, imageIdentity, supervisorImage] = await Promise.all([
  importFromDist("runner.js"),
  importFromDist("qemuCiRunnerImageAssets.js"),
  importFromDist("qemuCiRunnerImage.js"),
  importFromDist("qemuCiRunnerSupervisorImage.js")
]);

await writeFile(hookPath, imageAssets.QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT, { mode: 0o700 });
const hook = {
  sourceRef: "refs/heads/main",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  kind: "absent",
  digest: imageIdentity.QEMU_CI_NO_HOOK_DIGEST
};
const keys = supervisorImage.qemuCiRunnerProductionImageKeys({ projectId: "real-shared-qemu-project", hook });
const supervisorImageId = await supervisorImage.prepareQemuCiRunnerSupervisorImage(new ProcessRunner(), stateRoot);
await writeFile(outputPath, `${JSON.stringify({ ...keys, supervisorImageId, hook })}\n`, { mode: 0o600 });
