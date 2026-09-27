import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../errors.js";
import { ensureGitea } from "../gitea.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions, ProjectRepositoryRecord } from "../lifecycleTypes.js";
import type { CommandRunner } from "../types.js";
import { commandError, gitCredentialEnvironment, replaceRepository } from "./helpers.js";
import { protectProjectRepository } from "./repositoryProtection.js";
import { grantRepositoryUsers, revokeRepositoryUsers } from "./repositoryMembership.js";
import { prepareProjectRepositoryTransfer } from "./repositoryTransfer.js";
import type { CreateRepositoryInput } from "./types.js";

export async function completeProjectRepositoryTransfer(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string,
  aliasInput: string,
  transferId: string,
  result: { success: boolean; error?: string }
): Promise<ProjectRepositoryRecord> {
  const projectName = validateLifecycleName(projectNameInput, "project");
  const alias = validateLifecycleName(aliasInput, "repo alias");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    let project = await state.readProject(projectName);
    const existing = project.repositories.find((repo) => repo.alias === alias);
    if (!existing || existing.transferId !== transferId || existing.phase !== "importing") {
      throw new UserError(`repository transfer for '${projectName}/${alias}' is not active`);
    }
    const credentials = await ensureGitea(runner, options);
    await revokeRepositoryUsers(credentials, project.gitNamespace, alias);
    if (!result.success) {
      const repository = failedTransfer(existing, result.error ?? "Git transfer failed");
      await state.writeProject(replaceRepository(project, repository));
      return repository;
    }
    try {
      await protectProjectRepository(runner, credentials, { project, repository: existing });
    } catch (error) {
      const repository = failedTransfer(existing, error instanceof Error ? error.message : String(error));
      await state.writeProject(replaceRepository(project, repository));
      throw error;
    }
    try {
      await grantRepositoryUsers(credentials, project.gitNamespace, alias);
    } catch (error) {
      await revokeRepositoryUsers(credentials, project.gitNamespace, alias);
      const repository = failedTransfer(existing, error instanceof Error ? error.message : String(error));
      await state.writeProject(replaceRepository(project, repository));
      throw error;
    }
    const repository: ProjectRepositoryRecord = {
      ...existing,
      phase: "ready",
      protectionPhase: "applied",
      updatedAt: new Date().toISOString()
    };
    delete repository.transferId;
    delete repository.error;
    project = replaceRepository(project, repository);
    await state.writeProject(project);
    return repository;
  } finally {
    await release();
  }
}

function failedTransfer(repository: ProjectRepositoryRecord, error: string): ProjectRepositoryRecord {
  const failed = {
    ...repository,
    phase: "error" as const,
    protectionPhase: "pending" as const,
    updatedAt: new Date().toISOString(),
    error
  };
  delete failed.transferId;
  return failed;
}

export async function importProjectRepository(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: CreateRepositoryInput & { source: string }
): Promise<ProjectRepositoryRecord> {
  const prepared = await prepareProjectRepositoryTransfer(runner, options, input);
  if (prepared.transferId === undefined) return prepared.repository;
  const temporary = await mkdtemp(join(tmpdir(), "dim-repo-import-"));
  try {
    const clone = await runner.run("git", ["clone", "--mirror", input.source, join(temporary, "source.git")]);
    if (clone.exitCode !== 0) {
      const error = commandError(`clone '${input.source}'`, clone);
      await completeProjectRepositoryTransfer(
        runner, options, input.project, input.alias, prepared.transferId, { success: false, error: error.message }
      );
      throw error;
    }
    const credentials = await ensureGitea(runner, options);
    const push = await runner.run(
      "git",
      ["--git-dir", join(temporary, "source.git"), "push", "--mirror", prepared.repository.hostUrl],
      { env: gitCredentialEnvironment(credentials) }
    );
    if (push.exitCode !== 0) {
      const error = commandError(`push '${input.project}/${input.alias}'`, push);
      await completeProjectRepositoryTransfer(
        runner, options, input.project, input.alias, prepared.transferId, { success: false, error: error.message }
      );
      throw error;
    }
    return completeProjectRepositoryTransfer(
      runner, options, input.project, input.alias, prepared.transferId, { success: true }
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
