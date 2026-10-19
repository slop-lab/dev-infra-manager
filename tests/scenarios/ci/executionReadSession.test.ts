import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withNativeGitExecutionReadAuthority } from "../../../packages/host/plugins/ci-worker/src/nativeGitCandidateReadAuthority.js";
import { cleanupFinalizeFixtures, createFinalizeRoot, runGit } from "../../control-plane/plugins/native-git/nativeRootImportFinalizeFixture.js";
import { multiRepositoryExecutionFixture, type MultiRepositoryExecutionFixture } from "./multiRepositoryExecutionFixture.js";

let fixture: MultiRepositoryExecutionFixture;
beforeEach(async () => { fixture = await multiRepositoryExecutionFixture(); }, 30_000);
afterEach(cleanupFinalizeFixtures);

it.each(["dependency", "attempt"] as const)("rejects cached objects at handoff after %s authority changes and disposes every session", async (change) => {
  const f = fixture, grant = await f.authorize("joint"), credential = await f.source.candidate(grant);
  const directory = await createFinalizeRoot("revoked-read-session"), signal = AbortSignal.timeout(25_000);
  let callbackReachedEnd = false;
  await expect(withNativeGitExecutionReadAuthority({ descriptor: grant.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: f.native.service.origin, temporaryRoot: directory, credential }, signal, async (authority) => {
    for (const [repositoryId, snapshot] of Object.entries(grant.descriptor.inputs)) {
      await authority.readCommit({ projectId: grant.descriptor.projectId, repositoryId, objectId: snapshot.commit, signal });
    }
    expect((await readdir(directory)).length).toBe(2);
    if (change === "dependency") await f.promotePrivate();
    else await f.authorize("joint");
    // Immutable verified objects remain readable locally; the final live authorization
    // probe must still prevent handing them to an obsolete execution.
    const snapshot = grant.descriptor.inputs.private;
    if (!snapshot) throw new Error("missing private snapshot");
    await authority.readCommit({ projectId: grant.descriptor.projectId, repositoryId: "private", objectId: snapshot.commit, signal });
    callbackReachedEnd = true;
  })).rejects.toThrow("native Git operation failed");
  expect(callbackReachedEnd).toBe(true);
  expect(await readdir(directory)).toEqual([]);
}, 30_000);

it.each(["entries", "bytes"] as const)("enforces the job-total %s budget across individually admissible repositories", async (limit) => {
  const f = fixture, grant = await f.authorize("joint"), credential = await f.source.candidate(grant);
  const directory = await createFinalizeRoot("shared-read-budget"), temporaryRoot = join(directory, "sessions");
  await mkdir(temporaryRoot, { mode: 0o700 });
  const sizes = await Promise.all(Object.entries(grant.descriptor.inputs).map(async ([repositoryId, snapshot]) => {
    const git = ["--git-dir", join(f.native.root, `project-a/${repositoryId}.git`)];
    const entries = (await runGit("/usr/bin/git", [...git, "ls-tree", "-r", "-t", "--name-only", snapshot.commit])).stdout.trim().split("\n").length;
    const bytes = (await runGit("/usr/bin/git", [...git, "ls-tree", "-r", "-l", snapshot.commit])).stdout.trim().split("\n")
      .reduce((total, line) => total + Number(line.trim().split(/\s+/)[3]), 0);
    return { entries, bytes };
  }));
  const maximum = Math.max(...sizes.map((size) => size[limit]));
  expect(sizes.reduce((total, size) => total + size[limit], 0)).toBeGreaterThan(maximum);
  const signal = AbortSignal.timeout(25_000);
  await expect(withNativeGitExecutionReadAuthority({ descriptor: grant.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: f.native.service.origin, temporaryRoot, credential,
    limits: limit === "entries" ? { maximumEntries: maximum } : { maximumMaterializedBytes: maximum }
  }, signal, async (authority) => {
    for (const [repositoryId, snapshot] of Object.entries(grant.descriptor.inputs)) {
      await authority.materializeTree({ projectId: grant.descriptor.projectId, repositoryId,
        commitObjectId: snapshot.commit, treeObjectId: snapshot.tree, destination: join(directory, repositoryId), signal });
    }
  })).rejects.toThrow(/limit/);
  expect(await readdir(temporaryRoot)).toEqual([]);
}, 30_000);
