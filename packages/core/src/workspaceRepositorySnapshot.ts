import { UserError } from "./errors.js";
import type {
  GiteaCredentials,
  ProjectRecord,
  WorkspaceRecord,
  WorkspaceRepositorySnapshot,
  WorkspaceRepositorySnapshotEntry
} from "./lifecycleTypes.js";
import { inspectProjectRuntimeCgroups, type ProjectRuntimeCgroups } from "./projectRuntimeCgroups.js";
import { assertProjectRepositoriesReady } from "./protectedRootResolution.js";
import type { StreamingCommandRunner } from "./types.js";

const WORKSPACE_USER = "dim";
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

export async function resolveRepositorySnapshot(
  runner: StreamingCommandRunner,
  record: Pick<WorkspaceRecord, "rootRepositoryAlias" | "rootRef" | "rootCommit" | "repositoryRefOverrides"> & {
    readonly rootRequestedRef: string;
  },
  project: ProjectRecord,
  credentials: GiteaCredentials
): Promise<WorkspaceRepositorySnapshot> {
  const resolved: Record<string, WorkspaceRepositorySnapshotEntry> = {};
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  assertProjectRepositoriesReady(project);
  for (const repository of project.repositories) {
    const root = repository.alias === record.rootRepositoryAlias;
    if (root) {
      resolved[repository.alias] = {
        workspaceUrl: repository.workspaceUrl,
        phase: "ready",
        root: true,
        requestedRef: record.rootRequestedRef,
        ref: record.rootRef,
        commit: record.rootCommit
      };
      continue;
    }
    const requestedRef = record.repositoryRefOverrides?.[repository.alias] ?? repository.ref ?? "HEAD";
    const requestedCommit = COMMIT_PATTERN.test(requestedRef) ? requestedRef : undefined;
    const listed = await runner.run(
      "git",
      ["-c", `credential.helper=${helper}`, "ls-remote", "--symref", "--exit-code", repository.hostUrl,
        ...(requestedCommit ? [] : [requestedRef, `${requestedRef}^{}`])],
      { env: {
        ...process.env,
        DIM_GIT_USERNAME: credentials.writerUsername,
        DIM_GIT_TOKEN: credentials.writerPassword,
        GIT_TERMINAL_PROMPT: "0"
      } }
    );
    if (listed.exitCode !== 0) {
      throw commandError(`resolve repository ref '${project.name}/${repository.alias}:${requestedRef}'`, listed);
    }
    const lines = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
    const symbolic = requestedRef === "HEAD"
      ? lines.find((line) => line.startsWith("ref:"))?.match(/^ref:\s+(refs\/[^\s]+)\s+HEAD$/)?.[1]
      : undefined;
    const objectLine = requestedCommit
      ? lines.find((line) => line.startsWith(`${requestedCommit}\t`))
      : lines.find((line) => line.endsWith(`\t${requestedRef}^{}`))
        ?? lines.find((line) => /^[0-9a-f]{40,64}\s+/.test(line));
    const [commit, reportedRef] = objectLine?.split(/\s+/, 2) ?? [];
    if (!commit || !reportedRef) {
      throw new UserError(`repository ref '${project.name}/${repository.alias}:${requestedRef}' returned no commit`);
    }
    resolved[repository.alias] = {
      workspaceUrl: repository.workspaceUrl,
      phase: "ready",
      root: false,
      requestedRef,
      ref: requestedCommit ?? symbolic ?? reportedRef.replace(/\^\{\}$/, ""),
      commit
    };
  }
  assertRepositorySnapshotComplete(resolved, project, record.rootRepositoryAlias);
  return resolved;
}

export function assertWorkspaceRepositorySnapshot(record: WorkspaceRecord): void {
  const snapshot: unknown = record.repositorySnapshot;
  if (!isRecord(snapshot) || Object.keys(snapshot).length === 0) invalidSnapshot(record.name);
  let roots = 0;
  for (const [alias, entry] of Object.entries(snapshot)) {
    if (!ALIAS_PATTERN.test(alias) || !isRecord(entry)) invalidSnapshot(record.name);
    const phase = entry["phase"];
    const root = entry["root"];
    if (typeof entry["workspaceUrl"] !== "string" || entry["workspaceUrl"].length === 0
      || typeof root !== "boolean") invalidSnapshot(record.name);
    if (root) roots += 1;
    if (phase !== "ready"
      || !hasOnlyKeys(entry, ["workspaceUrl", "phase", "root", "requestedRef", "ref", "commit"])
      || typeof entry["requestedRef"] !== "string" || entry["requestedRef"].length === 0
      || typeof entry["ref"] !== "string" || entry["ref"].length === 0
      || typeof entry["commit"] !== "string" || !COMMIT_PATTERN.test(entry["commit"])) {
      invalidSnapshot(record.name);
    }
  }
  const root = snapshot[record.rootRepositoryAlias];
  if (!isRecord(root) || root["phase"] !== "ready" || root["root"] !== true
    || (root["requestedRef"] !== "HEAD" && root["requestedRef"] !== record.rootRef)
    || root["ref"] !== record.rootRef
    || root["commit"] !== record.rootCommit || roots !== 1) {
    invalidSnapshot(record.name);
  }
}

export function assertRepositorySnapshotComplete(
  snapshot: WorkspaceRepositorySnapshot,
  project: ProjectRecord,
  rootRepositoryAlias: string
): void {
  const expected = project.repositories.map(({ alias }) => alias).sort();
  const actual = Object.keys(snapshot).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || project.rootRepositoryAlias !== rootRepositoryAlias) {
    throw new UserError(`workspace repository snapshot does not match project '${project.name}'`);
  }
}

export async function writeProjectManifest(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  assertWorkspaceRepositorySnapshot(record);
  const cgroups = await inspectProjectRuntimeCgroups(runner, record.containerName, "docker");
  const encoded = Buffer.from(`${JSON.stringify(projectRuntimeManifest(record, cgroups), null, 2)}\n`).toString("base64");
  const result = await runner.run("docker", [
    "exec", "--user", "root", "--env", `DIM_PROJECT_MANIFEST_B64=${encoded}`,
    record.containerName, "sh", "-c",
    `mkdir -p /run/dim && printf %s "$DIM_PROJECT_MANIFEST_B64" | base64 -d > ${record.projectManifestPath} && chown ${WORKSPACE_USER}:${WORKSPACE_USER} ${record.projectManifestPath} && chmod 0444 ${record.projectManifestPath}`
  ]);
  if (result.exitCode !== 0) throw commandError("write project runtime manifest", result);
}

export function projectRuntimeManifest(
  record: WorkspaceRecord,
  cgroups: ProjectRuntimeCgroups
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    project: { id: record.projectId, name: record.projectName },
    root: {
      repository: record.rootRepositoryAlias,
      ref: record.rootRef,
      commit: record.rootCommit,
      path: record.projectPath
    },
    repositories: Object.fromEntries(Object.entries(record.repositorySnapshot)
      .sort(([left], [right]) => left.localeCompare(right))),
    gitBaseUrl: record.gitBaseUrl,
    hostAliases: record.hostAliases,
    runtime: {
      cgroups,
      capabilities: (record.capabilities ?? []).map(({ name, requirement, status, plugin, detail }) => ({
        name, requirement, status, ...(plugin ? { plugin } : {}), ...(detail ? { detail } : {})
      }))
    }
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidSnapshot(name: string): never {
  throw new UserError(`workspace '${name}' has an invalid repository snapshot; recreate the workspace`);
}

function commandError(action: string, result: { readonly stderr: string; readonly stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
