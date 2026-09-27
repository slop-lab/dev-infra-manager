import { spawn } from "node:child_process";
import {
  mapExternalRefToRepository,
  UserError,
  type RepositoryRefNamespace
} from "@slop-lab/dim-core";
import { adminCall } from "./controller-client.js";
import { runner } from "./cli-runtime.js";

export interface PreparedRepositoryTransfer {
  transferId?: string;
  repository: Record<string, unknown>;
  sourceUrl?: string;
  targetUrl: string;
  writerUsername?: string;
  writerPassword?: string;
}

export interface PreparedRepositorySync {
  projectId: string;
  repositoryAlias: string;
  externalUrl: string;
  refNamespace?: RepositoryRefNamespace;
  writerUsername: string;
  writerPassword: string;
  publishBranches: Record<string, string>;
  syncEndpoint: string;
  syncToken: string;
  syncTimeoutSeconds: number;
}

type GitCredential = {
  readonly username: string;
  readonly password: string;
};

export async function fetchRepository(projectName: string, alias: string, prune: boolean): Promise<void> {
  const prepared = await adminCall<PreparedRepositorySync>("repo.sync-prepare", {
    project: projectName,
    alias
  });
  await syncRequest(prepared, "fetch", {
    externalUrl: prepared.externalUrl,
    refNamespace: prepared.refNamespace ?? null,
    prune,
    externalCredential: await externalCredential(prepared.externalUrl, prepared.syncTimeoutSeconds),
    managedCredential: { username: prepared.writerUsername, password: prepared.writerPassword }
  });
}

export async function publishRepositories(projectName: string, alias?: string): Promise<string[]> {
  const aliases = alias === undefined
    ? (await adminCall<Array<{ alias: string; connections: Array<{ publishBranches?: Record<string, string> }> }>>(
        "repo.list", { project: projectName }
      )).filter((repository) => repository.connections.some(
        (connection) => Object.keys(connection.publishBranches ?? {}).length > 0
      )).map((repository) => repository.alias)
    : [alias];
  if (aliases.length === 0) throw new UserError(`project '${projectName}' has no repositories configured for publish`);
  for (const repositoryAlias of aliases) await publishRepository(projectName, repositoryAlias);
  return aliases;
}

async function publishRepository(projectName: string, alias: string): Promise<void> {
  const prepared = await adminCall<PreparedRepositorySync>("repo.sync-prepare", {
    project: projectName,
    alias
  });
  if (Object.keys(prepared.publishBranches).length === 0) {
    throw new UserError(`repo '${projectName}/${alias}' has no publish policy`);
  }
  await syncRequest(prepared, "publish", {
    externalUrl: prepared.externalUrl,
    refNamespace: prepared.refNamespace ?? null,
    publishBranches: prepared.publishBranches,
    externalCredential: await externalCredential(prepared.externalUrl, prepared.syncTimeoutSeconds)
  });
}

async function syncRequest(
  prepared: PreparedRepositorySync,
  operation: "fetch" | "publish",
  body: Readonly<Record<string, unknown>>
): Promise<void> {
  const pathname = `/v1/repositories/${encodeURIComponent(prepared.projectId)}/${encodeURIComponent(prepared.repositoryAlias)}/${operation}`;
  const response = await fetch(`${prepared.syncEndpoint}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${prepared.syncToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(prepared.syncTimeoutSeconds * 1_000)
  });
  if (response.status >= 300 && response.status < 400) {
    throw new UserError("Git sync service redirects are not allowed");
  }
  if (!response.ok) throw new UserError(`Git sync service rejected ${operation} (${response.status})`);
}

async function externalCredential(url: string, timeoutSeconds: number): Promise<GitCredential | null> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  const result = await new Promise<{ readonly exitCode: number; readonly stdout: string }>((resolve) => {
    const child = spawn("git", ["credential", "fill"], {
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "ignore"]
    });
    let stdout = "";
    let forceTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      terminateCredentialProcess(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateCredentialProcess(child, "SIGKILL"), 2_000);
    }, timeoutSeconds * 1_000);
    const finish = (exitCode: number): void => {
      clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({ exitCode, stdout });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => finish(127));
    child.on("close", (exitCode) => finish(exitCode ?? 1));
    child.stdin.end(`url=${url}\n\n`);
  });
  if (result.exitCode !== 0) return null;
  const fields = new Map(result.stdout.split("\n").flatMap((line) => {
    const separator = line.indexOf("=");
    return separator < 1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
  }));
  const username = fields.get("username");
  const password = fields.get("password");
  return username === undefined || password === undefined ? null : { username, password };
}

function terminateCredentialProcess(child: import("node:child_process").ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export function managedGitEnvironment(prepared: PreparedRepositorySync): NodeJS.ProcessEnv {
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  return {
    ...process.env,
    DIM_GIT_USERNAME: prepared.writerUsername,
    DIM_GIT_TOKEN: prepared.writerPassword,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: helper
  };
}

export function isBranchOrTagRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/");
}

export async function runGit(args: string[], env: NodeJS.ProcessEnv, action: string): Promise<void> {
  const exitCode = await runner.runStreaming("git", args, { env });
  if (exitCode !== 0) throw new UserError(`failed to ${action}: git exited with code ${exitCode}`);
}

export async function localRefs(gitDirectory: string, prefix: string): Promise<string[]> {
  const result = await runner.run("git", [
    "--git-dir", gitDirectory,
    "for-each-ref", "--format=%(refname)", prefix
  ], { env: process.env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect fetched refs");
  return result.stdout.split("\n").map((ref) => ref.trim()).filter(Boolean);
}

export async function materializeExternalRefs(
  gitDirectory: string,
  namespace: RepositoryRefNamespace | undefined,
  upstreamBranches: boolean
): Promise<void> {
  const result = await runner.run("git", [
    "--git-dir", gitDirectory,
    "for-each-ref", "--format=%(objectname) %(refname)", "refs/dim-external"
  ], { env: process.env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect external refs");
  for (const line of result.stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf(" ");
    const objectId = line.slice(0, separator);
    const stagingRef = line.slice(separator + 1);
    const externalRef = stagingRef.startsWith("refs/dim-external/heads/")
      ? `refs/heads/${stagingRef.slice("refs/dim-external/heads/".length)}`
      : `refs/tags/${stagingRef.slice("refs/dim-external/tags/".length)}`;
    const repositoryRef = mapExternalRefToRepository(namespace, externalRef);
    if (repositoryRef === undefined) continue;
    const targetRef = upstreamBranches && repositoryRef.startsWith("refs/heads/")
      ? `refs/heads/upstream/${repositoryRef.slice("refs/heads/".length)}`
      : repositoryRef;
    await runGit(
      ["--git-dir", gitDirectory, "update-ref", targetRef, objectId],
      process.env,
      `map external ref '${externalRef}'`
    );
  }
}

export async function remoteRefs(url: string, pattern: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await runner.run("git", ["ls-remote", "--refs", url, pattern], { env });
  if (result.exitCode !== 0) throw new UserError("failed to inspect managed upstream refs");
  return result.stdout.split("\n")
    .map((line) => line.trim().split(/\s+/, 2)[1])
    .filter((ref): ref is string => ref !== undefined);
}
