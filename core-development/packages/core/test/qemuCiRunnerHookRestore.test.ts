import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QemuCiProjectHookProvenance } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { restorePersistedQemuProjectHook } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import type { RestorePersistedQemuProjectHookInput } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";

const hookBytes = Buffer.from("#!/usr/bin/env bash\necho persisted\n");
const hook = {
  sourceRef: "refs/heads/admitted", sourceCommit: "a".repeat(40), kind: "present",
  digest: createHash("sha256").update(hookBytes).digest("hex")
} as const;

describe("persisted QEMU Project hook restoration", () => {
  let stateRoot = "";

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-qemu-hook-restore-"));
    await writeHook(stateRoot, "project-id");
  });

  afterEach(async () => { await rm(stateRoot, { recursive: true, force: true }); });

  it.each([
    ["hook bytes", async () => { await writeFile(paths(stateRoot, "project-id", hook).script, "tampered\n"); }, /digest/],
    ["provenance bytes", async () => { await writeFile(paths(stateRoot, "project-id", hook).provenance, "{}\n"); }, /provenance/],
    ["executable mode", async () => { await chmod(paths(stateRoot, "project-id", hook).script, 0o700); }, /mode/]
  ])("rejects mismatched %s", async (_case, corrupt, expected) => {
    // Given
    await corrupt();

    // When
    const restoration = restorePersistedQemuProjectHook({ stateRoot, projectId: "project-id", provenance: hook });

    // Then
    await expect(restoration).rejects.toThrow(expected);
  });

  it.each([
    ["Project ID", { stateRoot: "/state", projectId: "../bad", provenance: hook }, /project ID/],
    ["source commit", { stateRoot: "/state", projectId: "project-id", provenance: { ...hook, sourceCommit: "main" } }, /source commit/],
    ["digest", { stateRoot: "/state", projectId: "project-id", provenance: { ...hook, digest: "short" } }, /digest/]
  ] satisfies readonly [string, RestorePersistedQemuProjectHookInput, RegExp][])("validates persisted %s before reading the artifact", async (_case, input, expected) => {
    // Given / When
    const restoration = restorePersistedQemuProjectHook(input);

    // Then
    await expect(restoration).rejects.toThrow(expected);
  });
});

async function writeHook(stateRoot: string, projectId: string): Promise<void> {
  const artifact = paths(stateRoot, projectId, hook);
  await mkdir(artifact.directory, { recursive: true });
  await writeFile(artifact.script, hookBytes);
  await writeFile(artifact.provenance, `${JSON.stringify(hook, null, 2)}\n`);
  await chmod(artifact.script, 0o500);
}

function paths(stateRoot: string, projectId: string, provenance: QemuCiProjectHookProvenance): {
  readonly directory: string; readonly script: string; readonly provenance: string;
} {
  const directory = join(stateRoot, "assets", "qemu-ci-projects", projectId, "hooks", provenance.sourceCommit, `${provenance.kind}-${provenance.digest}`);
  return { directory, script: join(directory, "cache.bash"), provenance: join(directory, "provenance.json") };
}
