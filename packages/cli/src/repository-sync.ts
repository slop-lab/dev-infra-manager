import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mapExternalRefToRepository,
  mapRepositoryRefToExternal,
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
  externalUrl: string;
  refNamespace?: RepositoryRefNamespace;
  managedUrl: string;
  writerUsername: string;
  writerPassword: string;
  publishBranches: Record<string, string>;
}

export async function fetchRepository(projectName: string, alias: string, prune: boolean): Promise<void> {
  const prepared = await adminCall<PreparedRepositorySync>("repo.sync-prepare", {
    project: projectName,
    alias
  });
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-repo-fetch-"));
  const gitDirectory = path.join(temporary, "sync.git");
  try {
    await runGit(["init", "--bare", gitDirectory], process.env, "initialize temporary repository");
    await runGit([
      "--git-dir", gitDirectory,
      "fetch", "--no-tags", prepared.externalUrl,
      "+refs/heads/*:refs/dim-external/heads/*",
      "+refs/tags/*:refs/dim-external/tags/*"
    ], process.env, `fetch external repository '${projectName}/${alias}'`);
    await materializeExternalRefs(gitDirectory, prepared.refNamespace, true);

    const managedEnvironment = managedGitEnvironment(prepared);
    const upstreamRefs = await localRefs(gitDirectory, "refs/heads/upstream");
    const tagRefs = await localRefs(gitDirectory, "refs/tags");
    const managedUpstreamRefs = prune
      ? await remoteRefs(prepared.managedUrl, "refs/heads/upstream/*", managedEnvironment)
      : [];
    const branchRefspecs = upstreamRefs.map((ref) => `+${ref}:${ref}`);
    if (prune) {
      const fetched = new Set(upstreamRefs);
      branchRefspecs.push(...managedUpstreamRefs.filter((ref) => !fetched.has(ref)).map((ref) => `:${ref}`));
    }
    const tagRefspecs = tagRefs.map((ref) => `${ref}:${ref}`);
    if (tagRefspecs.length > 0) {
      await runGit([
        "--git-dir", gitDirectory,
        "push", "--dry-run", "--atomic", prepared.managedUrl,
        ...tagRefspecs
      ], managedEnvironment, `check tags for '${projectName}/${alias}'`);
    }
    if (branchRefspecs.length > 0) {
      await runGit([
        "--git-dir", gitDirectory,
        "push", "--atomic", prepared.managedUrl,
        ...branchRefspecs
      ], managedEnvironment, `update upstream branches for '${projectName}/${alias}'`);
    }
    if (tagRefspecs.length > 0) {
      await runGit([
        "--git-dir", gitDirectory,
        "push", "--atomic", prepared.managedUrl,
        ...tagRefspecs
      ], managedEnvironment, `update tags for '${projectName}/${alias}'`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
  const refspecs = Object.entries(prepared.publishBranches).map(([source, destination]) =>
    `refs/heads/${source}:refs/heads/${destination}`
  );
  if (refspecs.length === 0) throw new UserError(`repo '${projectName}/${alias}' has no publish policy`);
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-repo-push-"));
  const gitDirectory = path.join(temporary, "sync.git");
  try {
    await runGit(["init", "--bare", gitDirectory], process.env, "initialize temporary repository");
    const sourceRefs = [...new Set(refspecs.map((refspec) => {
      const source = refspec.slice(0, refspec.indexOf(":"));
      return `${source}:${source}`;
    }))];
    await runGit([
      "--git-dir", gitDirectory,
      "fetch", prepared.managedUrl,
      ...sourceRefs
    ], managedGitEnvironment(prepared), `read managed repository '${projectName}/${alias}'`);
    const externalRefspecs = refspecs.map((refspec) => {
      const separator = refspec.indexOf(":");
      const source = refspec.slice(0, separator);
      const destination = refspec.slice(separator + 1);
      return `${source}:${mapRepositoryRefToExternal(prepared.refNamespace, destination)}`;
    });
    await runGit([
      "--git-dir", gitDirectory,
      "push", prepared.externalUrl,
      ...externalRefspecs
    ], process.env, `push external repository '${projectName}/${alias}'`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
