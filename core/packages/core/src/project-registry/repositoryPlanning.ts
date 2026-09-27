import { MissingRecordError, UserError } from "../errors.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../lifecycleTypes.js";
import {
  assertRepositorySetCanCreateProject,
  resolveRepositoryConnection,
  type RepositorySet
} from "../repositorySet.js";
import { sameRepositoryTransport } from "./helpers.js";
import type { RepositorySetPlan, RepositorySetPlanAction } from "./types.js";

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
    if (!(error instanceof MissingRecordError)) throw error;
  }
  if (createProject && project) throw new UserError(`project '${projectName}' already exists`);
  if (!createProject && !project) throw new UserError(`project '${projectName}' not found`);
  if (createProject) assertRepositorySetCanCreateProject(set);
  const actions = Object.entries(set.repositories).map(([alias, entry]): RepositorySetPlanAction => {
    const existing = project?.repositories.find((repo) => repo.alias === alias);
    if (!existing) return { action: "create", alias, entry };
    const requestedConnection = resolveRepositoryConnection(set, alias);
    const existingConnection = existing.connections.find((connection) => connection.name === "origin");
    if (sameRepositoryTransport(existingConnection, requestedConnection)
      && JSON.stringify(existingConnection?.publishBranches ?? {})
        !== JSON.stringify(requestedConnection?.publishBranches ?? {})) {
      return { action: "retry", alias, entry, detail: "publish policy differs" };
    }
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
    if (existing.ref !== entry.ref) {
      return { action: "retry", alias, entry, detail: "checkout ref differs" };
    }
    if (JSON.stringify(existing.protectedPatterns) !== JSON.stringify(entry.protectedPatterns)
      || JSON.stringify(existing.forcePushBlockedPatterns ?? []) !== JSON.stringify(entry.forcePushBlockedPatterns)) {
      return { action: "retry", alias, entry, detail: "protection policy differs" };
    }
    if (existing.phase === "ready") return { action: "unchanged", alias, entry };
    return { action: "retry", alias, entry, detail: `current phase is ${existing.phase}` };
  });
  const requestedRoot = actions.find(({ entry }) => entry.root);
  if (project?.rootRepositoryAlias && requestedRoot && project.rootRepositoryAlias !== requestedRoot.alias) {
    actions.push({
      action: "conflict",
      alias: requestedRoot.alias,
      entry: requestedRoot.entry,
      detail: `project root is already '${project.rootRepositoryAlias}'`
    });
  }
  return { project: projectName, createProject, actions };
}
