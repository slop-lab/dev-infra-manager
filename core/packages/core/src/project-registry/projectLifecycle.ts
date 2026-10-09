import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { MissingRecordError, UserError } from "../errors.js";
import { ensureGitea, giteaRequest } from "../gitea.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../lifecycleTypes.js";
import { removeProtectedRootSnapshots } from "../protectedRootSnapshot.js";
import type { CommandRunner } from "../types.js";
import { ensureOrganization } from "./giteaRepository.js";
import { assertGiteaOrganizationIdentity, parseGiteaOrganizationIdentity } from "./giteaOrganization.js";
import { apiError, projectNamespace, withProjectError } from "./helpers.js";

export async function createProject(
  runner: CommandRunner,
  options: LifecycleOptions,
  nameInput: string
): Promise<ProjectRecord> {
  const name = validateLifecycleName(nameInput, "project");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(name);
  try {
    await assertNoNativeProjectDraft(options.stateRoot, name);
    const externalCredentials = options.giteaConnection.kind === "external"
      ? await ensureGitea(runner, options)
      : undefined;
    const gitNamespace = projectNamespace(name);
    const binding = externalCredentials?.kind === "external"
      ? externalCredentials.projectBindings[name]
      : undefined;
    if (externalCredentials !== undefined && binding === undefined) {
      throw new UserError(`external Gitea connection has no explicit Project binding for '${name}'`);
    }
    if (binding !== undefined && binding.gitNamespace !== gitNamespace) {
      throw new UserError(`external Gitea Project binding for '${name}' must use namespace '${gitNamespace}'`);
    }
    const now = new Date().toISOString();
    let record: ProjectRecord = {
      schemaVersion: 4,
      id: binding?.id ?? randomUUID(),
      name,
      gitNamespace,
      giteaOrganizationId: binding?.giteaOrganizationId ?? null,
      phase: "creating",
      repositories: [],
      createdAt: now,
      updatedAt: now
    };
    let selected = false;
    try {
      try {
        const existing = await state.readProject(name);
        if (binding !== undefined
          && (existing.id !== binding.id
            || existing.gitNamespace !== binding.gitNamespace
            || existing.giteaOrganizationId !== binding.giteaOrganizationId)) {
          throw new UserError(`project '${name}' does not match its external Gitea Project binding`);
        }
        if (existing.phase === "ready") throw new UserError(`project '${name}' already exists`);
        record = { ...existing, phase: "creating", updatedAt: now };
        delete record.error;
        await state.writeProject(record);
      } catch (error) {
        if (!(error instanceof MissingRecordError)) throw error;
        await state.claimProject(record);
      }
      selected = true;
      const credentials = externalCredentials ?? await ensureGitea(runner, options);
      const giteaOrganizationId = await ensureOrganization(
        credentials,
        record.gitNamespace,
        record.giteaOrganizationId
      );
      if (record.giteaOrganizationId === null) {
        record = { ...record, giteaOrganizationId, updatedAt: new Date().toISOString() };
        await state.writeProject(record);
      }
      record = { ...record, phase: "ready", updatedAt: new Date().toISOString() };
      await state.writeProject(record);
      return record;
    } catch (error) {
      if (selected) {
        record = withProjectError(record, error);
        await state.writeProject(record);
      }
      throw error;
    }
  } finally {
    await release();
  }
}

async function assertNoNativeProjectDraft(stateRoot: string, name: string): Promise<void> {
  const directory = join(stateRoot, "native-project-drafts");
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw new UserError("native Project draft directory cannot be inspected safely");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new UserError("native Project draft directory is unsafe");
  }
  try {
    await lstat(join(directory, `${name}.json`));
  } catch (error) {
    if (isMissing(error)) return;
    throw new UserError(`native Project draft '${name}' cannot be inspected safely`);
  }
  throw new UserError(`native Project draft '${name}' already exists`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function removeProject(options: LifecycleOptions, nameInput: string): Promise<void> {
  const name = validateLifecycleName(nameInput, "project");
  const state = new LifecycleState(options.stateRoot);
  const releaseProject = await state.acquireProjectLock(name);
  try {
    const releaseCiRunner = await state.acquireCiRunnerLock(name);
    try {
      const project = await state.readProject(name);
      assertRepositoryTransfersComplete(project);
      await assertProjectUnused(state, name);
      await removeProtectedRootSnapshots(options.stateRoot, project.id);
      await state.removeProject(name);
    } finally {
      await releaseCiRunner();
    }
  } finally {
    await releaseProject();
  }
}

export async function purgeProject(
  runner: CommandRunner,
  options: LifecycleOptions,
  nameInput: string
): Promise<void> {
  const name = validateLifecycleName(nameInput, "project");
  const state = new LifecycleState(options.stateRoot);
  const releaseProject = await state.acquireProjectLock(name);
  try {
    const releaseCiRunner = await state.acquireCiRunnerLock(name);
    try {
      const project = await state.readProject(name);
      assertRepositoryTransfersComplete(project);
      await assertProjectUnused(state, name);
      const credentials = await ensureGitea(runner, options);
      if (project.giteaOrganizationId === null) {
        throw new UserError(`project '${project.name}' has no trusted Gitea organization ID`);
      }
      const organization = await giteaRequest(credentials, "GET", `/orgs/${project.gitNamespace}`);
      if (organization.status === 404) {
        await removeProtectedRootSnapshots(options.stateRoot, project.id);
        await state.removeProject(name);
        return;
      }
      if (!organization.ok) {
        throw await apiError(`verify Gitea organization '${project.gitNamespace}'`, organization);
      }
      assertGiteaOrganizationIdentity(
        await parseGiteaOrganizationIdentity(organization, project.gitNamespace),
        project.giteaOrganizationId
      );
      for (const repo of project.repositories) {
        const deleted = await giteaRequest(
          credentials,
          "DELETE",
          `/repos/${project.gitNamespace}/${repo.alias}`
        );
        if (!deleted.ok && deleted.status !== 404) {
          throw await apiError(`delete Gitea repo '${project.gitNamespace}/${repo.alias}'`, deleted);
        }
      }
      const response = await giteaRequest(credentials, "DELETE", `/orgs/${project.gitNamespace}`);
      if (!response.ok && response.status !== 404) {
        throw await apiError(`delete Gitea organization '${project.gitNamespace}'`, response);
      }
      await removeProtectedRootSnapshots(options.stateRoot, project.id);
      await state.removeProject(name);
    } finally {
      await releaseCiRunner();
    }
  } finally {
    await releaseProject();
  }
}

function assertRepositoryTransfersComplete(project: ProjectRecord): void {
  const activeTransfer = project.repositories.find((repository) => repository.phase === "importing");
  if (activeTransfer !== undefined) {
    throw new UserError(
      `project '${project.name}' has active repository transfer for repo '${activeTransfer.alias}'`
    );
  }
}

export async function assertProjectUnused(state: LifecycleState, name: string): Promise<void> {
  const runners = (await state.listCiRunners()).filter((runner) => runner.projectName === name);
  if (runners.length > 0) {
    throw new UserError(
      `project '${name}' has CI runner${runners.length === 1 ? "" : "s"} ${runners.map((runner) => `'${runner.name}'`).join(", ")}; delete ${runners.length === 1 ? "it" : "them"} first`
    );
  }
  const references = (await state.listWorkspaces()).filter((workspace) => workspace.projectName === name);
  if (references.length > 0) {
    throw new UserError(
      `project '${name}' is used by workspace${references.length === 1 ? "" : "s"} ${references.map((item) => `'${item.name}'`).join(", ")}`
    );
  }
}
