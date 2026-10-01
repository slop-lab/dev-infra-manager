import { UserError } from "../errors.js";
import { validateLifecycleName } from "../lifecycleState.js";
import type {
  GiteaCredentials,
  ProjectRecord,
  ProjectRepositoryRecord,
  RepositoryConnection
} from "../lifecycleTypes.js";
import type { ResolvedRepositoryConnection } from "../repositorySet.js";

export function projectNamespace(name: string): string {
  return `dim-${validateLifecycleName(name, "project")}`;
}

export function assertReadyProject(project: ProjectRecord): void {
  if (project.phase !== "ready") {
    throw new UserError(`project '${project.name}' is not ready (phase: ${project.phase})`);
  }
  if (project.giteaOrganizationId === null) {
    throw new UserError(`project '${project.name}' is not ready without a trusted Gitea organization ID`);
  }
}

export function replaceRepository(project: ProjectRecord, repo: ProjectRepositoryRecord): ProjectRecord {
  return {
    ...project,
    repositories: project.repositories.map((candidate) => candidate.alias === repo.alias ? repo : candidate),
    updatedAt: repo.updatedAt
  };
}

export function withoutRepository(project: ProjectRecord, alias: string): ProjectRecord {
  return {
    ...project,
    repositories: project.repositories.filter((repository) => repository.alias !== alias),
    updatedAt: new Date().toISOString()
  };
}

export function withProjectError(project: ProjectRecord, error: unknown): ProjectRecord {
  return {
    ...project,
    phase: "error",
    updatedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error)
  };
}

export function sameRepositoryTransport(
  existing: RepositoryConnection | undefined,
  requested: ResolvedRepositoryConnection | undefined
): boolean {
  return JSON.stringify(existing === undefined ? undefined : {
    url: existing.url,
    ...(existing.refNamespace === undefined ? {} : { refNamespace: existing.refNamespace })
  }) === JSON.stringify(requested === undefined ? undefined : {
    url: requested.url,
    ...(requested.refNamespace === undefined ? {} : { refNamespace: requested.refNamespace })
  });
}

export function gitCredentialEnvironment(credentials: GiteaCredentials): NodeJS.ProcessEnv {
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

export async function apiError(action: string, response: Response): Promise<UserError> {
  return new UserError(`failed to ${action}: Gitea API ${response.status}: ${(await response.text()).trim()}`);
}

export function commandError(action: string, result: { stdout: string; stderr: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
