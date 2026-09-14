import { UserError } from "./errors.js";
import type { GiteaCredentials, ProjectRecord, ProjectRepositoryRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

export type ProtectedRootResolution = {
  readonly repository: ProjectRepositoryRecord;
  readonly requestedRef: string;
  readonly ref: string;
  readonly commit: string;
};

export async function resolveProtectedRoot(
  runner: StreamingCommandRunner,
  project: ProjectRecord,
  credentials: GiteaCredentials
): Promise<ProtectedRootResolution> {
  const repository = protectedRootRepository(project);
  const requestedRef = project.rootRef ?? "HEAD";
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  const listed = await runner.run(
    "git",
    ["-c", `credential.helper=${helper}`, "ls-remote", "--symref", "--exit-code", repository.hostUrl, requestedRef],
    { env: gitEnvironment(credentials) }
  );
  if (listed.exitCode !== 0) throw commandError(`resolve protected root '${project.name}:${requestedRef}'`, listed);
  const lines = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
  const ref = requestedRef === "HEAD"
    ? lines.find((line) => line.startsWith("ref:"))?.match(/^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/)?.[1]
    : requestedRef;
  if (ref === undefined || !isConcreteBranchRef(ref)) {
    throw new UserError(`project '${project.name}' root ref '${requestedRef}' does not resolve to a concrete branch`);
  }
  const branch = ref.slice("refs/heads/".length);
  if (!repository.protectedPatterns.some((pattern) => matchesProtectionPattern(branch, pattern))) {
    throw new UserError(`project '${project.name}' root branch '${branch}' is not covered by protected patterns`);
  }
  const objectLine = lines.find((line) =>
    /^[0-9a-f]{40,64}\s+/.test(line)
    && (line.endsWith(`\t${requestedRef}`) || line.endsWith(`\t${ref}`))
  );
  const commit = objectLine?.split(/\s+/, 1)[0];
  if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new UserError(`project '${project.name}' protected root '${ref}' returned an invalid Git commit`);
  }
  return { repository, requestedRef, ref, commit };
}

export function assertProjectRepositoriesReady(project: ProjectRecord): void {
  const pending = project.repositories.find(({ phase }) => phase !== "ready");
  if (pending !== undefined) {
    throw new UserError(`project '${project.name}' repository '${pending.alias}' is not ready (phase: ${pending.phase})`);
  }
}

function protectedRootRepository(project: ProjectRecord): ProjectRepositoryRecord {
  if (project.rootRepositoryAlias === undefined) throw new UserError(`project '${project.name}' has no root repo`);
  const repository = project.repositories.find(({ alias }) => alias === project.rootRepositoryAlias);
  if (repository === undefined || repository.phase !== "ready") {
    throw new UserError(`project '${project.name}' root repo '${project.rootRepositoryAlias}' is not ready`);
  }
  if (repository.protectionPhase !== "applied") {
    throw new UserError(`project '${project.name}' root repo '${repository.alias}' protection is not applied`);
  }
  assertProjectRepositoriesReady(project);
  return repository;
}

function isConcreteBranchRef(ref: string): boolean {
  return /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes("..") && !ref.endsWith("/");
}

function matchesProtectionPattern(branch: string, pattern: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${expression}$`).test(branch);
}

function gitEnvironment(credentials: GiteaCredentials): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIM_GIT_USERNAME: credentials.writerUsername,
    DIM_GIT_TOKEN: credentials.writerPassword,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function commandError(action: string, result: { readonly stderr: string; readonly stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
