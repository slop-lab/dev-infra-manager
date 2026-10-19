import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startControlPlanePlugins } from "../../../../core/packages/control-plane/src/runtime.js";
import { controlPlanePlugin as native } from "../../../../plugin-control-plane-native-git/src/controlPlanePlugin.js";
import { controlPlanePlugin as workflows } from "../../../../plugin-control-plane-ci-workflows/src/index.js";
import { inspectNativeGitBundleState } from "../../../../plugin-control-plane-native-git/src/native-bundle-state.js";
import { idleNativeConfig } from "../../native-git/test/bundleConfigFixture.js";

it("native plugin fails before opening state when its workflow capability is missing, then starts and closes a real standalone service", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-cp-plugin-"));
  const configuration = { service: idleNativeConfig(), stateDirectory: join(root, "state"),
    readinessToken: Buffer.alloc(32, 41).toString("base64url"), activationToken: Buffer.alloc(32, 42).toString("base64url"),
    expectedGenerationId: "a".repeat(64), listen: { host: "127.0.0.1", port: 0 } };
  const entries = [{ plugin: native, config: configuration }, { plugin: workflows, config: {} }];
  try {
    await expect(startControlPlanePlugins(entries.slice(0, 1), new AbortController().signal)).rejects.toThrow(/requires a workflow compiler/);
    expect(await readdir(root)).toEqual([]);
    const service = await startControlPlanePlugins(entries, new AbortController().signal);
    await service.close(); await service.close();
    expect((await inspectNativeGitBundleState(configuration.stateDirectory)).stateFormat).toBe(9);
    // Closing releases persistent state ownership without deleting durable data.
    const restarted = await startControlPlanePlugins(entries, new AbortController().signal); await restarted.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
