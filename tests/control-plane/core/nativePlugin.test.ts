import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlanePlugins } from "../../../packages/control-plane/core/src/runtime.js";
import { controlPlanePlugin as native } from "../../../packages/control-plane/plugins/git-repositories/src/controlPlanePlugin.js";
import { inspectNativeGitBundleState } from "../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js";
import { idleNativeConfig } from "../plugins/git-repositories/bundleConfigFixture.js";

it("repository plugin starts and releases its owned state without review or workflow plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-cp-plugin-"));
  const { humanReviewers: _reviewers, hostPromoters: _promoters, ci: _ci, ...repository } = idleNativeConfig();
  const configuration = { service: repository, stateDirectory: join(root, "state"),
    readinessToken: Buffer.alloc(32, 41).toString("base64url"), activationToken: Buffer.alloc(32, 42).toString("base64url"),
    expectedGenerationId: "a".repeat(64), listen: { host: "127.0.0.1", port: 0 } };
  const entries = [{ plugin: native, config: configuration }];
  try {
    const service = await startControlPlanePlugins(entries, new AbortController().signal);
    await service.close(); await service.close();
    expect((await inspectNativeGitBundleState(configuration.stateDirectory)).stateFormat).toBe(11);
    // Closing releases persistent state ownership without deleting durable data.
    const restarted = await startControlPlanePlugins(entries, new AbortController().signal); await restarted.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
