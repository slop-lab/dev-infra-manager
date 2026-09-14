import { UserError } from "../errors.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { LifecycleOptions, ProjectRecord, ProjectRepositoryRecord } from "../lifecycleTypes.js";

export async function listProjects(options: LifecycleOptions): Promise<ProjectRecord[]> {
  return new LifecycleState(options.stateRoot).listProjects();
}

export async function showProject(options: LifecycleOptions, name: string): Promise<ProjectRecord> {
  return new LifecycleState(options.stateRoot).readProject(validateLifecycleName(name, "project"));
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
