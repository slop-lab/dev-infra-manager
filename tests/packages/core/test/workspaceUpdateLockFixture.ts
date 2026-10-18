import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import type { NativeWorkspaceRecord, ProjectRecord, WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import { seedTestHostMirrorOwnership, TEST_HOST_MIRROR_PROVIDER } from "./hostLifecycleFixture.js";
import { nativeProjectFixture, nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";
import { COMMIT, INITIAL_COMMIT } from "./workspaceUpdateLockRunner.js";

export function options(stateRoot: string) {
  seedTestHostMirrorOwnership(stateRoot);
  return {
    ...lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot,
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: join(stateRoot, "control.json") }),
    hostMirrorProvider: TEST_HOST_MIRROR_PROVIDER
  };
}

export function projectFixture(): ProjectRecord {
  return nativeProjectFixture({ rootCommit: COMMIT });
}

export function workspaceFixture(project: ProjectRecord): WorkspaceRecord {
  return nativeWorkspaceFixture({ projectId: project.projectId, projectName: project.name,
    rootCommit: INITIAL_COMMIT, environment: "custom", profiles: ["development"], source: {
      kind: "native", serviceId: "native-main", snapshot: { projectId: project.projectId,
        repositoryId: "root", protectedRef: project.protectedRef, commit: INITIAL_COMMIT,
        tree: project.rootTree }, policyRevision: project.reviewPolicy.policyRevision,
      requiredReviewRevision: project.reviewPolicy.requiredReviewRevision,
      requiredJobSetRevision: project.reviewPolicy.requiredJobSetRevision
    } });
}

export function selectedWorkspaceFixture(record: NativeWorkspaceRecord): NativeWorkspaceRecord {
  return { ...record, rootCommit: COMMIT, source: { ...record.source,
    snapshot: { ...record.source.snapshot, commit: COMMIT } } };
}

export async function seedSelectedRootSnapshot(stateRoot: string, project: ProjectRecord): Promise<void> {
  const lifecycleRoot = join(stateRoot, "assets", "native-project-roots", project.projectId, COMMIT, ".dim");
  await mkdir(lifecycleRoot, { recursive: true });
  await writeFile(join(lifecycleRoot, "setup.sh"), "#!/bin/sh\n", { mode: 0o755 });
}

export async function captureFailure(operation: Promise<unknown>): Promise<Error> {
  const failure = await operation.then(
    () => undefined,
    (error: unknown) => error
  );
  if (!(failure instanceof Error)) throw new Error("operation did not reject with an Error");
  return failure;
}
