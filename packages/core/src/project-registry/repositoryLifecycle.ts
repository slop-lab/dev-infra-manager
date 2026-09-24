import { UserError } from "../errors.js";
import { ensureGitea, giteaHostCloneUrl, giteaInternalCloneUrl, giteaRequest } from "../gitea.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions, ProjectRecord, ProjectRepositoryRecord } from "../lifecycleTypes.js";
import type { CommandRunner } from "../types.js";
import { createGiteaRepository } from "./giteaRepository.js";
import { grantRepositoryUsers } from "./repositoryMembership.js";
import { normalizeRepositoryRef } from "../repositoryRef.js";
import { apiError, assertReadyProject, replaceRepository, withoutRepository } from "./helpers.js";
import { assertProjectUnused } from "./projectLifecycle.js";
import type { CreateRepositoryInput } from "./types.js";

export async function createProjectRepository(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: CreateRepositoryInput
): Promise<ProjectRepositoryRecord> {
  const projectName = validateLifecycleName(input.project, "project");
  const alias = validateLifecycleName(input.alias, "repo alias");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  let project = await state.readProject(projectName);
  try {
    assertReadyProject(project);
    const existingRepo = project.repositories.find((repo) => repo.alias === alias);
    if (existingRepo?.phase === "ready") throw new UserError(`repo '${projectName}/${alias}' already exists`);
    if (input.root && project.rootRepositoryAlias !== undefined && project.rootRepositoryAlias !== alias) {
      throw new UserError(`project '${projectName}' already has root repo '${project.rootRepositoryAlias}'`);
    }
    const credentials = await ensureGitea(runner, options);
    const now = new Date().toISOString();
    let repo: ProjectRepositoryRecord = existingRepo === undefined
      ? {
          alias,
          providerRepoId: `${project.gitNamespace}/${alias}`,
          owner: project.gitNamespace,
          hostUrl: giteaHostCloneUrl(credentials, project.gitNamespace, alias),
          workspaceUrl: giteaInternalCloneUrl(credentials, project.gitNamespace, alias),
          ...(input.ref === undefined ? {} : { ref: normalizeRepositoryRef(input.ref) }),
          phase: "creating",
          connections: [],
          protectedPatterns: input.protectedPatterns,
          forcePushBlockedPatterns: input.forcePushBlockedPatterns ?? [],
          protectionPhase: "pending",
          createdAt: now,
          updatedAt: now
        }
      : {
          ...existingRepo,
          ...(input.ref === undefined ? {} : { ref: normalizeRepositoryRef(input.ref) }),
          phase: "creating",
          updatedAt: now,
          protectedPatterns: input.protectedPatterns,
          forcePushBlockedPatterns: input.forcePushBlockedPatterns ?? []
        };
    delete repo.transferId;
    delete repo.error;
    project = {
      ...project,
      ...(input.root
        ? {
            rootRepositoryAlias: alias,
            ...(input.ref === undefined ? {} : { rootRef: normalizeRepositoryRef(input.ref) })
          }
        : {}),
      repositories: existingRepo === undefined
        ? [...project.repositories, repo]
        : project.repositories.map((candidate) => candidate.alias === alias ? repo : candidate),
      updatedAt: now
    };
    await state.writeProject(project);

    try {
      await createGiteaRepository(credentials, project.gitNamespace, alias, input.root);
      await grantRepositoryUsers(credentials, project.gitNamespace, alias);
      repo = { ...repo, phase: "ready", updatedAt: new Date().toISOString() };
      project = replaceRepository(project, repo);
      await state.writeProject(project);
      return repo;
    } catch (error) {
      repo = {
        ...repo,
        phase: "error",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      await state.writeProject(replaceRepository(project, repo));
      throw error;
    }
  } finally {
    await release();
  }
}

export async function deleteProjectRepository(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string,
  aliasInput: string
): Promise<void> {
  const projectName = validateLifecycleName(projectNameInput, "project");
  const alias = validateLifecycleName(aliasInput, "repo alias");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    const project = await deletableProjectRepository(state, projectName, alias);
    const credentials = await ensureGitea(runner, options);
    const response = await giteaRequest(credentials, "DELETE", `/repos/${project.gitNamespace}/${alias}`);
    if (!response.ok && response.status !== 404) {
      throw await apiError(`delete Gitea repo '${project.gitNamespace}/${alias}'`, response);
    }
    await state.writeProject(withoutRepository(project, alias));
  } finally {
    await release();
  }
}

async function deletableProjectRepository(
  state: LifecycleState,
  projectName: string,
  alias: string
): Promise<ProjectRecord> {
  const project = await state.readProject(projectName);
  assertReadyProject(project);
  if (!project.repositories.some((repository) => repository.alias === alias)) {
    throw new UserError(`repo '${projectName}/${alias}' not found`);
  }
  if (project.rootRepositoryAlias === alias) {
    throw new UserError(
      `repo '${projectName}/${alias}' is the project root; remove or purge the project instead`
    );
  }
  const repository = project.repositories.find((candidate) => candidate.alias === alias);
  if (repository?.phase === "importing") {
    throw new UserError(`repo '${projectName}/${alias}' is importing`);
  }
  await assertProjectUnused(state, projectName);
  return project;
}
