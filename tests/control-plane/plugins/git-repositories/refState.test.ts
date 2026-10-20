import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { atomicPromote, compareAndSwapProtectedRef, readNativeProjectRootCurrentHeadFromDatabase, readProtectedRefTransition, repositoryTransitionId, saveRepositoryRefIntent, type RepositoryRefTransition } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { fixture, git } from "./optionalFeaturesFixture.js";

async function candidate(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.source, "README.md"), "candidate\n");
  const candidateCommit = await f.commit();
  await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
  const candidateTree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  const target = { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef, expectedCommit: f.initial, candidateCommit, candidateTree, authorizationId: "b".repeat(64), evidenceDigest: "c".repeat(64) };
  return target;
}
it("binds protected-ref CAS to exact repository/head/authorization and returns one durable receipt for retries", async () => {
  const f = await fixture(false);
  try {
    const input = await candidate(f);
    const change = () => f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, input));
    expect(await change()).toEqual({ outcome: "promoted", sequence: 1 });
    expect(await change()).toEqual({ outcome: "already-current", sequence: 1 });
    expect(readProtectedRefTransition(f.service.context.runtime, input.authorizationId)).toMatchObject(input);
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, { ...input, evidenceDigest: "d".repeat(64) }))).rejects.toThrow(/head conflicts/);
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, { ...input, repositoryId: "private" }))).rejects.toThrow(/not registered/);
    expect(readNativeProjectRootCurrentHeadFromDatabase(f.service.context.runtime.state.database, "project", "main")).toMatchObject({ sequence: 1, commit: input.candidateCommit, tree: input.candidateTree });
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

it.each([false, true])("finalizes accepted ref changes and cancels unaccepted intents without replay (Git changed: %s)", async (gitAlreadyChanged) => {
  const f = await fixture(false);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const input = await candidate(f);
    const current = readNativeProjectRootCurrentHeadFromDatabase(f.service.context.runtime.state.database, "project", "main");
    const imported = (await import("@slop-lab/dim-control-plane-plugin-git-repositories/extensions")).readNativeProjectRootImportsFromDatabase(f.service.context.runtime.state.database)[0];
    if (imported === undefined) throw new Error("import is missing");
    const transition: RepositoryRefTransition = { ...input, sequence: 1, importNonce: imported.importNonce, expectedTree: current.tree, protectedRef: current.protectedRef, policyDigest: current.policyDigest, refPolicyRevision: "e".repeat(64), generationId: f.service.context.runtime.expectedGenerationId };
    saveRepositoryRefIntent(f.service.context.runtime.state.database, transition);
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(f.service.context.runtime.state.database, "project", "main")).toThrow(/recovery is pending/);
    if (gitAlreadyChanged) expect(await atomicPromote({ gitExecutable: "/usr/bin/git", storageRoot: f.options.stateDirectory }, transition, input.expectedCommit, input.candidateCommit)).toBe(true);
    await f.service.close();
    restarted = await configuredNativeGitBundleServer(f.options);
    if (!gitAlreadyChanged) {
      expect(readProtectedRefTransition(restarted.context.runtime, input.authorizationId)).toBeUndefined();
      expect(readNativeProjectRootCurrentHeadFromDatabase(restarted.context.runtime.state.database, "project", "main").commit).toBe(input.expectedCommit);
      expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(input.expectedCommit);
      return;
    }
    expect(readProtectedRefTransition(restarted.context.runtime, input.authorizationId)).toMatchObject({ sequence: 1, candidateCommit: input.candidateCommit });
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(input.candidateCommit);
    // Rehashing the persisted record cannot authorize a transition from a false base.
    const database = new DatabaseSync(restarted.context.runtime.state.database);
    try { const altered = { ...transition, expectedCommit: "f".repeat(40) }; database.prepare("UPDATE repository_ref_transition SET transition_id=?,record_json=?").run(repositoryTransitionId(altered), JSON.stringify(altered)); } finally { database.close(); }
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(restarted!.context.runtime.state.database, "project", "main")).toThrow(/chain is invalid/);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 20_000);
