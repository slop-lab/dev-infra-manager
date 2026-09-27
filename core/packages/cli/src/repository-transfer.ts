import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveRepositoryConnection,
  UserError,
  type RepositorySet,
  type RepositorySetEntry
} from "@slop-lab/dim-core";
import { adminCall } from "./controller-client.js";
import { runner } from "./cli-runtime.js";
import { localRefs, materializeExternalRefs, type PreparedRepositoryTransfer } from "./repository-sync.js";
import type { RepositorySetPlan } from "./repository-set-types.js";

export async function applyRepositorySet(
  projectName: string,
  set: RepositorySet,
  plan: RepositorySetPlan
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const action of plan.actions) {
    if (action.action === "unchanged") continue;
    if (action.action === "conflict") throw new UserError(`repository '${action.alias}' conflicts with existing state`);
    const result = await addRepository(projectName, action.alias, action.entry, set);
    const repository = (result.repository ?? result) as Record<string, unknown>;
    results.push(repository.protectionPhase === "pending"
      ? await adminCall<Record<string, unknown>>("repo.protect", { project: projectName, alias: action.alias })
      : result);
  }
  return results;
}

export async function addRepository(
  projectName: string,
  alias: string,
  entry: RepositorySetEntry & { mirror?: boolean },
  set?: RepositorySet
): Promise<Record<string, unknown>> {
  const connection = set === undefined
    ? (entry.url === undefined ? undefined : { url: entry.url })
    : resolveRepositoryConnection(set, alias);
  const prepared = await adminCall<PreparedRepositoryTransfer>("repo.prepare", {
    project: projectName,
    alias,
    root: entry.root,
    protectedPatterns: entry.protectedPatterns,
    forcePushBlockedPatterns: entry.forcePushBlockedPatterns,
    ...(connection === undefined ? {} : {
      source: connection.url,
      ...(connection.refNamespace === undefined ? {} : { refNamespace: connection.refNamespace }),
      ...(connection.publishBranches === undefined ? {} : { publishBranches: connection.publishBranches })
    }),
    ...(entry.ref === undefined ? {} : { ref: entry.ref })
  });
  if (!prepared.transferId || !prepared.sourceUrl) return prepared.repository;
  const temporary = await mkdtemp(path.join(tmpdir(), "dim-repo-transfer-"));
  const mirror = path.join(temporary, "source.git");
  try {
    let exitCode = await runner.runStreaming("git", ["init", "--bare", mirror], { env: process.env });
    if (exitCode === 0) {
      exitCode = await runner.runStreaming("git", [
        "--git-dir", mirror,
        "fetch", "--no-tags", prepared.sourceUrl,
        ...(entry.mirror
          ? ["+refs/*:refs/*"]
          : ["+refs/heads/*:refs/dim-external/heads/*", "+refs/tags/*:refs/dim-external/tags/*"])
      ], { env: process.env });
    }
    if (exitCode === 0 && !entry.mirror) {
      await materializeExternalRefs(mirror, connection?.refNamespace, false);
    }
    if (exitCode === 0) {
      if (!prepared.writerUsername || !prepared.writerPassword) {
        throw new UserError("controller did not provide managed Git transfer credentials");
      }
      const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
      const importedRefs = entry.mirror
        ? []
        : [
            ...(await localRefs(mirror, "refs/heads")).map((ref) => `${ref}:${ref}`),
            ...(await localRefs(mirror, "refs/tags")).map((ref) => `${ref}:${ref}`)
          ];
      if (!entry.mirror && importedRefs.length === 0) {
        throw new UserError(`external repository '${projectName}/${alias}' contains no branches or tags`);
      }
      exitCode = await runner.runStreaming("git", [
        "--git-dir", mirror,
        "-c", "credential.helper=",
        "-c", `credential.helper=${helper}`,
        "push",
        ...(entry.mirror ? ["--mirror"] : []),
        prepared.targetUrl,
        ...importedRefs
      ], {
        env: {
          ...process.env,
          DIM_GIT_USERNAME: prepared.writerUsername,
          DIM_GIT_TOKEN: prepared.writerPassword,
          GIT_TERMINAL_PROMPT: "0"
        }
      });
    }
    if (exitCode !== 0) {
      await adminCall("repo.complete", {
        project: projectName,
        alias,
        transferId: prepared.transferId,
        success: false,
        error: `git transfer exited with code ${exitCode}`
      });
      throw new UserError(`failed to import repository '${projectName}/${alias}'`);
    }
    return await adminCall<Record<string, unknown>>("repo.complete", {
      project: projectName,
      alias,
      transferId: prepared.transferId,
      success: true
    });
  } catch (error) {
    if (!(error instanceof UserError && error.message.startsWith("failed to import repository"))) {
      await adminCall("repo.complete", {
        project: projectName,
        alias,
        transferId: prepared.transferId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
