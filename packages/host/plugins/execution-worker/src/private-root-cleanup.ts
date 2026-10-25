import { createHash } from "node:crypto";
import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";
import type { ExecutionGrant } from "@slop-lab/dim-contracts-ci/aggregate";
import { cleanupNativeContainer, ownershipLabels } from "./backends/containers.js";

export type NativeHostPrivateRootCleanup = { readonly runner: StreamingCommandRunner; readonly grant: ExecutionGrant };

/** Called only after the host has verified its exact disposable root and stopped the owned job. */
export async function removeOwnedPrivateRootContents(input: NativeHostPrivateRootCleanup & {
  readonly path: string; readonly device: string; readonly inode: string; readonly marker: string;
}): Promise<boolean> {
  const kind = "private-root-cleanup";
  const name = `dim-ci-cleanup-${createHash("sha256").update(input.path).update(input.grant.executionId).digest("hex").slice(0, 20)}`;
  if (!/@sha256:[0-9a-f]{64}$/.test(input.grant.descriptor.runnerBaseImage)) return false;
  let removed = false;
  try {
    if (!await cleanupNativeContainer(input.runner, input.grant, kind, name)) return false;
    const result = await input.runner.run("docker", ["run", "--rm", "--name", name, "--pull", "never",
      "--network", "none", "--read-only", "--userns", "host", "--user", "0:0",
      "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
      "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "134217728", "--pids-limit", "64",
      ...ownershipLabels(input.grant, kind).flatMap((label) => ["--label", label]),
      "--mount", `type=bind,source=${input.path},target=/work`,
      "--entrypoint", "/bin/sh", input.grant.descriptor.runnerBaseImage, "-eu", "-c",
      'test "$(stat -c %d:%i /work)" = "$1"\ntest "$(cat /work/.dim-native-ordinary-owner.json)" = "$2"\nfind /work -mindepth 1 -maxdepth 1 ! -name .dim-native-ordinary-owner.json -exec rm -rf -- {} +',
      "dim-private-root-cleanup", `${input.device}:${input.inode}`, input.marker
    ], { signal: AbortSignal.timeout(60_000) });
    removed = result.exitCode === 0;
  } catch { removed = false; }
  finally {
    try { if (!await cleanupNativeContainer(input.runner, input.grant, kind, name)) removed = false; }
    catch { removed = false; }
  }
  return removed;
}
