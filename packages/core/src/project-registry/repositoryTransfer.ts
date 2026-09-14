import { randomUUID } from "node:crypto";
import { UserError } from "../errors.js";
import { ensureGitea, giteaHostCloneUrl, giteaInternalCloneUrl } from "../gitea.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions, ProjectRecord, ProjectRepositoryRecord } from "../lifecycleTypes.js";
import type { RepositoryRefNamespace } from "../repositorySet.js";
import type { CommandRunner } from "../types.js";
import { createGiteaRepository } from "./giteaRepository.js";
import { normalizeRepositoryRef } from "../repositoryRef.js";
import { assertReadyProject, sameRepositoryTransport } from "./helpers.js";
import { grantRepositoryTransferUser, grantRepositoryUsers } from "./repositoryMembership.js";
import { showProjectRepository } from "./queries.js";
import type { CreateRepositoryInput, PreparedRepositorySync, PreparedRepositoryTransfer } from "./types.js";

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
    publishBranches: connection.publishBranches ?? {},
    managedUrl: repository.hostUrl,
    writerUsername: credentials.writerUsername,
    writerPassword: credentials.writerPassword
  };
}

export async function prepareProjectRepositoryTransfer(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: CreateRepositoryInput & {
    source?: string;
    refNamespace?: RepositoryRefNamespace;
    publishBranches?: Record<string, string>;
  }
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
      : {
          name: "origin" as const,
          url: input.source,
          ...(input.refNamespace === undefined ? {} : { refNamespace: input.refNamespace }),
          ...(input.publishBranches === undefined || Object.keys(input.publishBranches).length === 0
            ? {}
            : { publishBranches: input.publishBranches })
        };
    const existingConnection = existing?.connections.find((connection) => connection.name === "origin");
    if (existing?.phase === "ready") {
      const protectionChanged = JSON.stringify(existing.protectedPatterns) !== JSON.stringify(input.protectedPatterns)
        || JSON.stringify(existing.forcePushBlockedPatterns ?? [])
          !== JSON.stringify(input.forcePushBlockedPatterns ?? []);
      if (sameRepositoryTransport(existingConnection, requestedConnection)
        && (JSON.stringify(existingConnection?.publishBranches ?? {})
          !== JSON.stringify(requestedConnection?.publishBranches ?? {})
          || existing.ref !== (input.ref === undefined ? undefined : normalizeRepositoryRef(input.ref))
          || protectionChanged)) {
        const updated: ProjectRepositoryRecord = {
          ...existing,
          connections: requestedConnection === undefined ? [] : [requestedConnection],
          protectedPatterns: input.protectedPatterns,
          forcePushBlockedPatterns: input.forcePushBlockedPatterns ?? [],
          protectionPhase: protectionChanged ? "pending" : existing.protectionPhase,
          updatedAt: new Date().toISOString()
        };
        if (input.ref === undefined) delete updated.ref;
        else updated.ref = normalizeRepositoryRef(input.ref);
        const updatedProject: ProjectRecord = {
          ...project,
          repositories: project.repositories.map((candidate) => candidate.alias === alias ? updated : candidate),
          updatedAt: updated.updatedAt
        };
        if (input.root) {
          if (project.rootRepositoryAlias !== undefined && project.rootRepositoryAlias !== alias) {
            throw new UserError(`project '${projectName}' already has root repo '${project.rootRepositoryAlias}'`);
          }
          updatedProject.rootRepositoryAlias = alias;
          if (updated.ref === undefined) delete updatedProject.rootRef;
          else updatedProject.rootRef = updated.ref;
        }
        await state.writeProject(updatedProject);
        return {
          repository: updated,
          ...(input.source === undefined ? {} : { sourceUrl: input.source }),
          targetUrl: updated.hostUrl
        };
      }
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
          ...(input.ref === undefined ? {} : { rootRef: normalizeRepositoryRef(input.ref) }),
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
          ...(input.ref === undefined ? {} : { ref: normalizeRepositoryRef(input.ref) }),
          phase: input.source === undefined ? "ready" : "importing",
          protectedPatterns: input.protectedPatterns,
          forcePushBlockedPatterns: input.forcePushBlockedPatterns ?? [],
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
          ...(input.ref === undefined ? {} : { ref: normalizeRepositoryRef(input.ref) }),
          phase: input.source === undefined ? "ready" : "importing",
          connections: requestedConnection === undefined ? [] : [requestedConnection],
          ...(transferId === undefined ? {} : { transferId }),
          protectedPatterns: input.protectedPatterns,
          forcePushBlockedPatterns: input.forcePushBlockedPatterns ?? [],
          protectionPhase: "pending",
          createdAt: now,
          updatedAt: now
        };
    if (transferId === undefined) delete repository.transferId;
    delete repository.error;
    project = {
      ...project,
      ...(input.root ? {
        rootRepositoryAlias: alias,
        ...(input.ref === undefined ? {} : { rootRef: normalizeRepositoryRef(input.ref) })
      } : {}),
      repositories: existing
        ? project.repositories.map((candidate) => candidate.alias === alias ? repository : candidate)
        : [...project.repositories, repository],
      updatedAt: now
    };
    await createGiteaRepository(credentials, project.gitNamespace, alias, input.root);
    if (transferId === undefined) await grantRepositoryUsers(credentials, project.gitNamespace, alias);
    else await grantRepositoryTransferUser(credentials, project.gitNamespace, alias);
    await state.writeProject(project);
    return {
      ...(transferId === undefined ? {} : { transferId }),
      repository,
      ...(input.source === undefined ? {} : {
        sourceUrl: input.source,
        writerUsername: credentials.maintainerUsername,
        writerPassword: credentials.maintainerPassword
      }),
      targetUrl: repository.hostUrl
    };
  } finally {
    await release();
  }
}
