import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.js";
import {
  ensureGitea,
  giteaHostCloneUrl,
  giteaInternalCloneUrl,
  giteaRequest
} from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type {
  GiteaCredentials,
  LifecycleOptions,
  ProjectRecord,
  ProjectRepositoryRecord
} from "./lifecycleTypes.js";
import {
  assertRepositorySetCanCreateProject,
  resolveRepositoryConnection,
  type RepositoryRefNamespace,
  type RepositorySet,
  type RepositorySetEntry
} from "./repositorySet.js";
import type { CommandRunner } from "./types.js";

export interface CreateRepositoryInput {
  project: string;
  alias: string;
  protectedPatterns: string[];
  root: boolean;
  rootRef?: string;
}

export async function createProject(
  runner: CommandRunner,
  options: LifecycleOptions,
  nameInput: string
): Promise<ProjectRecord> {
  const name = validateLifecycleName(nameInput, "project");
  const state = new LifecycleState(options.stateRoot);
  const now = new Date().toISOString();
  let record: ProjectRecord = {
    schemaVersion: 3,
    id: randomUUID(),
    name,
    gitNamespace: projectNamespace(name),
    phase: "creating",
    repositories: [],
    createdAt: now,
    updatedAt: now
  };
  try {
    const existing = await state.readProject(name);
    if (existing.phase === "ready") throw new UserError(`project '${name}' already exists`);
    record = { ...existing, phase: "creating", updatedAt: now };
    delete record.error;
    await state.writeProject(record);
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
    await state.claimProject(record);
  }
  const release = await state.acquireProjectLock(name);
  try {
    const credentials = await ensureGitea(runner, options);
    await ensureOrganization(options, credentials, record.gitNamespace);
    record = { ...record, phase: "ready", updatedAt: new Date().toISOString() };
    await state.writeProject(record);
    return record;
  } catch (error) {
    record = withProjectError(record, error);
    await state.writeProject(record);
    throw error;
  } finally {
    await release();
  }
}

export async function listProjects(options: LifecycleOptions): Promise<ProjectRecord[]> {
  return new LifecycleState(options.stateRoot).listProjects();
}

export async function showProject(options: LifecycleOptions, name: string): Promise<ProjectRecord> {
  return new LifecycleState(options.stateRoot).readProject(validateLifecycleName(name, "project"));
}

export async function removeProject(options: LifecycleOptions, nameInput: string): Promise<void> {
  const name = validateLifecycleName(nameInput, "project");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(name);
  try {
    await state.readProject(name);
    await assertProjectUnused(state, name);
    await state.removeProject(name);
  } finally {
    await release();
  }
}

export async function purgeProject(
  runner: CommandRunner,
  options: LifecycleOptions,
  nameInput: string
): Promise<void> {
  const name = validateLifecycleName(nameInput, "project");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(name);
  try {
    const project = await state.readProject(name);
    await assertProjectUnused(state, name);
    const credentials = await ensureGitea(runner, options);
    for (const repo of project.repositories) {
      const deleted = await giteaRequest(
        options,
        credentials,
        "DELETE",
        `/repos/${project.gitNamespace}/${repo.alias}`
      );
      if (!deleted.ok && deleted.status !== 404) {
        throw await apiError(`delete Gitea repo '${project.gitNamespace}/${repo.alias}'`, deleted);
      }
    }
    const response = await giteaRequest(options, credentials, "DELETE", `/orgs/${project.gitNamespace}`);
    if (!response.ok && response.status !== 404) {
      throw await apiError(`delete Gitea organization '${project.gitNamespace}'`, response);
    }
    await state.removeProject(name);
  } finally {
    await release();
  }
}

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
    const now = new Date().toISOString();
    let repo: ProjectRepositoryRecord = existingRepo === undefined
      ? {
          alias,
          providerRepoId: `${project.gitNamespace}/${alias}`,
          owner: project.gitNamespace,
          hostUrl: giteaHostCloneUrl(options, project.gitNamespace, alias),
          workspaceUrl: giteaInternalCloneUrl(project.gitNamespace, alias),
          phase: "creating",
          connections: [],
          protectedPatterns: input.protectedPatterns,
          protectionPhase: "pending",
          createdAt: now,
          updatedAt: now
        }
      : {
          ...existingRepo,
          phase: "creating",
          updatedAt: now,
          protectedPatterns: input.protectedPatterns
        };
    delete repo.error;
    project = {
      ...project,
      ...(input.root
        ? {
            rootRepositoryAlias: alias,
            ...(input.rootRef === undefined ? {} : { rootRef: normalizeRootRef(input.rootRef) })
          }
        : {}),
      repositories: existingRepo === undefined
        ? [...project.repositories, repo]
        : project.repositories.map((candidate) => candidate.alias === alias ? repo : candidate),
      updatedAt: now
    };
    await state.writeProject(project);

    try {
      const credentials = await ensureGitea(runner, options);
      await createGiteaRepository(options, credentials, project.gitNamespace, alias);
      await grantWriter(options, credentials, project.gitNamespace, alias);
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

export interface RepositorySetPlanAction {
  action: "create" | "retry" | "unchanged" | "conflict";
  alias: string;
  entry: RepositorySetEntry;
  detail?: string;
}

export interface RepositorySetPlan {
  project: string;
  createProject: boolean;
  actions: RepositorySetPlanAction[];
}

export async function planProjectRepositorySet(
  options: LifecycleOptions,
  projectNameInput: string,
  set: RepositorySet,
  createProject: boolean
): Promise<RepositorySetPlan> {
  const projectName = validateLifecycleName(projectNameInput, "project");
  let project: ProjectRecord | undefined;
  try {
    project = await new LifecycleState(options.stateRoot).readProject(projectName);
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
  }
  if (createProject && project) throw new UserError(`project '${projectName}' already exists`);
  if (!createProject && !project) throw new UserError(`project '${projectName}' not found`);
  if (createProject) assertRepositorySetCanCreateProject(set);
  const actions = Object.entries(set.repositories).map(([alias, entry]): RepositorySetPlanAction => {
    const existing = project?.repositories.find((repo) => repo.alias === alias);
    if (!existing) return { action: "create", alias, entry };
    const requestedConnection = resolveRepositoryConnection(set, alias);
    const existingConnection = existing.connections.find((connection) => connection.name === "origin");
    if (JSON.stringify(existingConnection) !== JSON.stringify(requestedConnection === undefined
      ? undefined
      : { name: "origin", ...requestedConnection })) {
      return {
        action: "conflict",
        alias,
        entry,
        detail: `existing origin is ${existingConnection?.url ?? "(empty repository)"}`
      };
    }
    const existingIsRoot = project?.rootRepositoryAlias === alias;
    if (existingIsRoot !== entry.root) {
      return { action: "conflict", alias, entry, detail: existingIsRoot ? "existing repository is the project root" : "root role differs" };
    }
    if (entry.rootRef !== undefined && project?.rootRef !== entry.rootRef) {
      return { action: "conflict", alias, entry, detail: `existing root ref is ${project?.rootRef ?? "(default HEAD)"}` };
    }
    if (JSON.stringify(existing.protectedPatterns) !== JSON.stringify(entry.protectedPatterns)) {
      return { action: "conflict", alias, entry, detail: "configured protection patterns differ" };
    }
    if (existing.phase === "ready") return { action: "unchanged", alias, entry };
    return { action: "retry", alias, entry, detail: `current phase is ${existing.phase}` };
  });
  const requestedRoot = actions.find(({ entry }) => entry.root)?.alias;
  if (project?.rootRepositoryAlias && requestedRoot && project.rootRepositoryAlias !== requestedRoot) {
    actions.push({
      action: "conflict",
      alias: requestedRoot,
      entry: set.repositories[requestedRoot]!,
      detail: `project root is already '${project.rootRepositoryAlias}'`
    });
  }
  return { project: projectName, createProject, actions };
}

export interface PreparedRepositoryTransfer {
  transferId?: string;
  repository: ProjectRepositoryRecord;
  sourceUrl?: string;
  targetUrl: string;
  writerUsername?: string;
  writerPassword?: string;
}

export interface PreparedRepositorySync {
  externalUrl: string;
  refNamespace?: RepositoryRefNamespace;
  managedUrl: string;
  writerUsername: string;
  writerPassword: string;
}

export async function prepareProjectRepositorySync(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectName: string,
  alias: string
): Promise<PreparedRepositorySync> {
  const repository = await showProjectRepository(options, projectName, alias);
  if (repository.phase !== "ready") {
    throw new UserError(`repo '${projectName}/${alias}' is not ready`);
  }
  const connection = repository.connections.find((candidate) => candidate.name === "origin");
  if (connection === undefined) {
    throw new UserError(`repo '${projectName}/${alias}' has no external origin`);
  }
  const credentials = await ensureGitea(runner, options);
  return {
    externalUrl: connection.url,
    ...(connection.refNamespace === undefined ? {} : { refNamespace: connection.refNamespace }),
    managedUrl: repository.hostUrl,
    writerUsername: credentials.writerUsername,
    writerPassword: credentials.writerPassword
  };
}

export async function prepareProjectRepositoryTransfer(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: CreateRepositoryInput & { source?: string; refNamespace?: RepositoryRefNamespace }
): Promise<PreparedRepositoryTransfer> {
  const projectName = validateLifecycleName(input.project, "project");
  const alias = validateLifecycleName(input.alias, "repo alias");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    let project = await state.readProject(projectName);
    assertReadyProject(project);
    const existing = project.repositories.find((repo) => repo.alias === alias);
    const requestedConnection = input.source === undefined
      ? undefined
      : { name: "origin" as const, url: input.source, ...(input.refNamespace === undefined ? {} : { refNamespace: input.refNamespace }) };
    const existingConnection = existing?.connections.find((connection) => connection.name === "origin");
    if (existing?.phase === "ready") {
      if (JSON.stringify(existingConnection) !== JSON.stringify(requestedConnection)) {
        throw new UserError(`repo '${projectName}/${alias}' already exists with a different origin`);
      }
      if (input.root && project.rootRepositoryAlias !== alias) {
        if (project.rootRepositoryAlias !== undefined) {
          throw new UserError(`project '${projectName}' already has root repo '${project.rootRepositoryAlias}'`);
        }
        project = {
          ...project,
          rootRepositoryAlias: alias,
          ...(input.rootRef === undefined ? {} : { rootRef: normalizeRootRef(input.rootRef) }),
          updatedAt: new Date().toISOString()
        };
        await state.writeProject(project);
      }
      return {
        repository: existing,
        ...(input.source === undefined ? {} : { sourceUrl: input.source }),
        targetUrl: existing.hostUrl
      };
    }
    if (existing && JSON.stringify(existingConnection) !== JSON.stringify(requestedConnection)) {
      throw new UserError(`repo '${projectName}/${alias}' has a different pending origin`);
    }
    if (input.root && project.rootRepositoryAlias !== undefined && project.rootRepositoryAlias !== alias) {
      throw new UserError(`project '${projectName}' already has root repo '${project.rootRepositoryAlias}'`);
    }
    const credentials = await ensureGitea(runner, options);
    const now = new Date().toISOString();
    const transferId = input.source === undefined ? undefined : randomUUID();
    const repository: ProjectRepositoryRecord = existing
      ? {
          ...existing,
          phase: input.source === undefined ? "ready" : "importing",
          protectedPatterns: input.protectedPatterns,
          connections: requestedConnection === undefined ? [] : [requestedConnection],
          ...(transferId === undefined ? {} : { transferId }),
          updatedAt: now
        }
      : {
          alias,
          providerRepoId: `${project.gitNamespace}/${alias}`,
          owner: project.gitNamespace,
          hostUrl: giteaHostCloneUrl(options, project.gitNamespace, alias),
          workspaceUrl: giteaInternalCloneUrl(project.gitNamespace, alias),
          phase: input.source === undefined ? "ready" : "importing",
          connections: requestedConnection === undefined ? [] : [requestedConnection],
          ...(transferId === undefined ? {} : { transferId }),
          protectedPatterns: input.protectedPatterns,
          protectionPhase: "pending",
          createdAt: now,
          updatedAt: now
        };
    delete repository.error;
    project = {
      ...project,
      ...(input.root ? {
        rootRepositoryAlias: alias,
        ...(input.rootRef === undefined ? {} : { rootRef: normalizeRootRef(input.rootRef) })
      } : {}),
      repositories: existing
        ? project.repositories.map((candidate) => candidate.alias === alias ? repository : candidate)
        : [...project.repositories, repository],
      updatedAt: now
    };
    await createGiteaRepository(options, credentials, project.gitNamespace, alias);
    await grantWriter(options, credentials, project.gitNamespace, alias);
    await state.writeProject(project);
    return {
      ...(transferId === undefined ? {} : { transferId }),
      repository,
      ...(input.source === undefined ? {} : {
        sourceUrl: input.source,
        writerUsername: credentials.writerUsername,
        writerPassword: credentials.writerPassword
      }),
      targetUrl: repository.hostUrl
    };
  } finally {
    await release();
  }
}

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
  let repository: ProjectRepositoryRecord;
  try {
    let project = await state.readProject(projectName);
    const existing = project.repositories.find((repo) => repo.alias === alias);
    if (!existing || existing.transferId !== transferId || existing.phase !== "importing") {
      throw new UserError(`repository transfer for '${projectName}/${alias}' is not active`);
    }
    repository = {
      ...existing,
      phase: result.success ? "ready" : "error",
      updatedAt: new Date().toISOString(),
      ...(result.success ? {} : { error: result.error ?? "Git transfer failed" })
    };
    delete repository.transferId;
    if (result.success) delete repository.error;
    project = replaceRepository(project, repository);
    await state.writeProject(project);
  } finally {
    await release();
  }
  return result.success
    ? applyProjectRepositoryProtection(runner, options, projectName, alias)
    : repository;
}

export async function importProjectRepository(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: CreateRepositoryInput & { source: string }
): Promise<ProjectRepositoryRecord> {
  const repo = await createProjectRepository(runner, options, input);
  const temporary = await mkdtemp(join(tmpdir(), "dim-repo-import-"));
  try {
    const clone = await runner.run("git", ["clone", "--mirror", input.source, join(temporary, "source.git")]);
    if (clone.exitCode !== 0) throw commandError(`clone '${input.source}'`, clone);
    const credentials = await ensureGitea(runner, options);
    const push = await runner.run(
      "git",
      ["--git-dir", join(temporary, "source.git"), "push", "--mirror", repo.hostUrl],
      { env: gitCredentialEnvironment(credentials) }
    );
    if (push.exitCode !== 0) throw commandError(`push '${input.project}/${input.alias}'`, push);
    return applyProjectRepositoryProtection(runner, options, input.project, input.alias);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function listProjectRepositories(
  options: LifecycleOptions,
  project: string
): Promise<ProjectRepositoryRecord[]> {
  return (await showProject(options, project)).repositories
    .slice()
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function showProjectRepository(
  options: LifecycleOptions,
  projectName: string,
  aliasInput: string
): Promise<ProjectRepositoryRecord> {
  const project = await showProject(options, projectName);
  const alias = validateLifecycleName(aliasInput, "repo alias");
  const repo = project.repositories.find((candidate) => candidate.alias === alias);
  if (!repo) throw new UserError(`repo '${project.name}/${alias}' not found`);
  return repo;
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
    const response = await giteaRequest(
      options,
      credentials,
      "DELETE",
      `/repos/${project.gitNamespace}/${alias}`
    );
    if (!response.ok && response.status !== 404) {
      throw await apiError(`delete Gitea repo '${project.gitNamespace}/${alias}'`, response);
    }
    await state.writeProject(withoutRepository(project, alias));
  } finally {
    await release();
  }
}

export async function projectRepositoryHostUrl(
  options: LifecycleOptions,
  project: string,
  alias: string
): Promise<string> {
  return (await showProjectRepository(options, project, alias)).hostUrl;
}

export async function projectRepositoryWorkspaceUrl(
  options: LifecycleOptions,
  project: string,
  alias: string
): Promise<string> {
  return (await showProjectRepository(options, project, alias)).workspaceUrl;
}

export async function readProjectRootRepositorySetYaml(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string
): Promise<string | undefined> {
  const project = await showProject(options, validateLifecycleName(projectNameInput, "project"));
  if (!project.rootRepositoryAlias) throw new UserError(`project '${project.name}' has no root repository`);
  const repository = await showProjectRepository(options, project.name, project.rootRepositoryAlias);
  const credentials = await ensureGitea(runner, options);
  const temporary = await mkdtemp(join(tmpdir(), "dim-root-manifest-"));
  const gitDirectory = join(temporary, "root.git");
  try {
    const cloned = await runner.run("git", ["clone", "--mirror", repository.hostUrl, gitDirectory], {
      env: gitCredentialEnvironment(credentials)
    });
    if (cloned.exitCode !== 0) throw commandError(`read root repository '${project.name}'`, cloned);
    const ref = project.rootRef ?? "HEAD";
    const shown = await runner.run("git", ["--git-dir", gitDirectory, "show", `${ref}:.dim/repos.yml`]);
    if (shown.exitCode === 0) return shown.stdout;
    if (/does not exist|exists on disk, but not in|invalid object name|unknown revision|bad object/i.test(shown.stderr)) {
      return undefined;
    }
    throw commandError(`read ${ref}:.dim/repos.yml`, shown);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function applyProjectRepositoryProtection(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string,
  aliasInput: string
): Promise<ProjectRepositoryRecord> {
  const projectName = validateLifecycleName(projectNameInput, "project");
  const alias = validateLifecycleName(aliasInput, "repo alias");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    let project = await state.readProject(projectName);
    let repo = project.repositories.find((candidate) => candidate.alias === alias);
    if (!repo) throw new UserError(`repo '${projectName}/${alias}' not found`);
    if (repo.phase !== "ready") throw new UserError(`repo '${projectName}/${alias}' is not ready`);
    if (repo.protectionPhase === "applied") return repo;
    const credentials = await ensureGitea(runner, options);
    if (project.rootRepositoryAlias === alias && project.rootRef === undefined) {
      await ensureSingleBranchHead(runner, options, credentials, project.gitNamespace, repo);
    }
    for (const pattern of repo.protectedPatterns) {
      await protectBranch(options, credentials, project.gitNamespace, alias, pattern);
    }
    repo = { ...repo, protectionPhase: "applied", updatedAt: new Date().toISOString() };
    project = replaceRepository(project, repo);
    await state.writeProject(project);
    return repo;
  } finally {
    await release();
  }
}

async function ensureSingleBranchHead(
  runner: CommandRunner,
  options: LifecycleOptions,
  credentials: GiteaCredentials,
  organization: string,
  repo: ProjectRepositoryRecord
): Promise<void> {
  const repository = await giteaRequest(options, credentials, "GET", `/repos/${organization}/${repo.alias}`);
  if (!repository.ok) throw await apiError(`inspect repo '${organization}/${repo.alias}'`, repository);
  const metadata = await repository.json() as { default_branch?: string };
  const listed = await runner.run("git", ["ls-remote", "--heads", repo.hostUrl], {
    env: gitCredentialEnvironment(credentials)
  });
  if (listed.exitCode !== 0) throw commandError(`list branches for '${organization}/${repo.alias}'`, listed);
  const names = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/\srefs\/heads\/(.+)$/)?.[1])
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (metadata.default_branch && names.includes(metadata.default_branch)) return;
  if (names.length !== 1) return;
  const updated = await giteaRequest(options, credentials, "PATCH", `/repos/${organization}/${repo.alias}`, {
    default_branch: names[0]
  });
  if (!updated.ok) throw await apiError(`set root HEAD for '${organization}/${repo.alias}'`, updated);
}

export function projectNamespace(name: string): string {
  return `dim-${validateLifecycleName(name, "project")}`;
}

export function normalizeRootRef(value: string): string {
  const ref = value.startsWith("refs/") ? value : `refs/heads/${value}`;
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new UserError(`root ref '${value}' is invalid`);
  }
  return ref;
}

function assertReadyProject(project: ProjectRecord): void {
  if (project.phase !== "ready") {
    throw new UserError(`project '${project.name}' is not ready (phase: ${project.phase})`);
  }
}

async function ensureOrganization(
  options: LifecycleOptions,
  credentials: GiteaCredentials,
  organization: string
): Promise<void> {
  const response = await giteaRequest(options, credentials, "POST", "/orgs", {
    username: organization,
    full_name: organization,
    visibility: "public"
  });
  if (response.ok) return;
  if (response.status === 422) {
    const existing = await giteaRequest(options, credentials, "GET", `/orgs/${organization}`);
    if (existing.ok) return;
  }
  throw await apiError(`create Gitea organization '${organization}'`, response);
}

async function createGiteaRepository(
  options: LifecycleOptions,
  credentials: GiteaCredentials,
  organization: string,
  alias: string
): Promise<void> {
  const response = await giteaRequest(options, credentials, "POST", `/orgs/${organization}/repos`, {
    name: alias,
    private: false,
    auto_init: false
  });
  if (response.ok) return;
  if (response.status === 409 || response.status === 422) {
    const existing = await giteaRequest(options, credentials, "GET", `/repos/${organization}/${alias}`);
    if (existing.ok) return;
  }
  throw await apiError(`create repo '${organization}/${alias}'`, response);
}

async function grantWriter(
  options: LifecycleOptions,
  credentials: GiteaCredentials,
  organization: string,
  alias: string
): Promise<void> {
  const response = await giteaRequest(
    options,
    credentials,
    "PUT",
    `/repos/${organization}/${alias}/collaborators/${credentials.writerUsername}`,
    { permission: "write" }
  );
  if (!response.ok && response.status !== 204) {
    throw await apiError(`grant writer access to '${organization}/${alias}'`, response);
  }
}

async function protectBranch(
  options: LifecycleOptions,
  credentials: GiteaCredentials,
  organization: string,
  alias: string,
  pattern: string
): Promise<void> {
  const response = await giteaRequest(
    options,
    credentials,
    "POST",
    `/repos/${organization}/${alias}/branch_protections`,
    {
      branch_name: pattern,
      enable_push: false,
      enable_merge_whitelist: true,
      merge_whitelist_usernames: [credentials.adminUsername],
      required_approvals: 1,
      block_on_rejected_reviews: true,
      dismiss_stale_approvals: true
    }
  );
  if (!response.ok && response.status !== 409 && response.status !== 422) {
    throw await apiError(`protect branch pattern '${pattern}'`, response);
  }
}

function replaceRepository(
  project: ProjectRecord,
  repo: ProjectRepositoryRecord
): ProjectRecord {
  return {
    ...project,
    repositories: project.repositories.map((candidate) => candidate.alias === repo.alias ? repo : candidate),
    updatedAt: repo.updatedAt
  };
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
  await assertProjectUnused(state, projectName);
  return project;
}

function withoutRepository(project: ProjectRecord, alias: string): ProjectRecord {
  return {
    ...project,
    repositories: project.repositories.filter((repository) => repository.alias !== alias),
    updatedAt: new Date().toISOString()
  };
}

function withProjectError(project: ProjectRecord, error: unknown): ProjectRecord {
  return {
    ...project,
    phase: "error",
    updatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error)
  };
}

function gitCredentialEnvironment(credentials: GiteaCredentials): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIM_GIT_USERNAME: credentials.adminUsername,
    DIM_GIT_TOKEN: credentials.adminPassword,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f"
  };
}

async function apiError(action: string, response: Response): Promise<UserError> {
  return new UserError(`failed to ${action}: Gitea API ${response.status}: ${(await response.text()).trim()}`);
}

function commandError(
  action: string,
  result: { stdout: string; stderr: string }
): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}

async function assertProjectUnused(state: LifecycleState, name: string): Promise<void> {
  try {
    await state.readCiRunner(name);
    throw new UserError(`project '${name}' has an enabled CI runner; disable it first`);
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
  }
  const references = (await state.listWorkspaces()).filter((workspace) => workspace.projectName === name);
  if (references.length > 0) {
    throw new UserError(
      `project '${name}' is used by workspace${references.length === 1 ? "" : "s"} ${references.map((item) => `'${item.name}'`).join(", ")}`
    );
  }
}
