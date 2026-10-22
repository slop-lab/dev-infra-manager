import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { compareAndSwapProtectedRef, readNativeProjectRootCurrentHeadFromDatabase, resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { ensureConfiguredRepositoryBranches } from "../../../../packages/control-plane/plugins/git-repositories/src/repository-branches.js";
import { fixture, basic, generationId, git, record, token } from "./optionalFeaturesFixture.js";
const headers = { authorization: basic({ username: "importer", password: token(1) }), "x-dim-generation-id": generationId, "content-type": "application/json" };
const policyPath = "/v1/projects/project/repositories/main/policy";
async function configure(f: Awaited<ReturnType<typeof fixture>>, defaultRef = "refs/heads/main", additional: Readonly<Record<string, { readonly review: boolean }>> = {}) {
  const response = await fetch(`${f.origin}${policyPath}`, { headers });
  expect(response.status).toBe(200);
  const previous = record(await response.json());
  const body = { protectedRef: "refs/heads/main", defaultRef, branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false }, ...additional }, extensions: {} };
  const policy = { schemaVersion: 1, ...body, policyRevision: nativeRepositoryPolicyRevision(body) };
  return fetch(`${f.origin}${policyPath}`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: record(previous.currentHead).commit, policy }) });
}
async function candidate(f: Awaited<ReturnType<typeof fixture>>, content: string, protectedRef: string, expectedCommit: string, id: string) {
  await writeFile(join(f.source, "README.md"), content);
  const candidateCommit = await f.commit();
  await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
  const candidateTree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  return { projectId: "project", repositoryId: "main", protectedRef, proposalRef: f.proposalRef, expectedCommit, candidateCommit, candidateTree, authorizationId: id.repeat(64), evidenceDigest: "c".repeat(64) };
}
it("serializes two managed branches independently, retains their exact heads across restart and refuses force promotion", async () => {
  const f = await fixture(false);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const configured = await configure(f);
    expect(configured.status, await configured.clone().text()).toBe(200);
    const runtime = f.service.context.runtime;
    const repository = join(f.root, "state/project/main.git");
    expect((await git("/usr/bin/git", ["--git-dir", repository, "symbolic-ref", "HEAD"])).stdout.trim()).toBe("refs/heads/main");
    const read = (ref: string) => readNativeProjectRootCurrentHeadFromDatabase(runtime.state.database, "project", "main", ref);
    expect(read("refs/heads/development").commit).toBe(f.initial);
    const development = await candidate(f, "development\n", "refs/heads/development", f.initial, "b");
    expect(await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, development))).toEqual({ outcome: "promoted", sequence: 1 });
    expect(read("refs/heads/main")).toMatchObject({ commit: f.initial, sequence: 1 });
    expect((await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: "project", repositoryId: "main" })).currentHead.commit).toBe(f.initial);
    const expanded = await configure(f, "refs/heads/main", { "refs/heads/release": { review: true } });
    expect(expanded.status, await expanded.clone().text()).toBe(200);
    expect(read("refs/heads/release")).toMatchObject({ commit: f.initial, sequence: 1 });
    const main = { ...development, protectedRef: "refs/heads/main", authorizationId: "d".repeat(64) };
    expect(await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, main))).toEqual({ outcome: "promoted", sequence: 2 });
    expect(read("refs/heads/development")).toMatchObject({ commit: development.candidateCommit, sequence: 2 });
    expect(await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, main))).toEqual({ outcome: "already-current", sequence: 2 });
    const initialTree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", `${f.initial}^{tree}`])).stdout.trim();
    for (const protectedRef of ["refs/heads/main", "refs/heads/development"]) {
      await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, { ...main, protectedRef, expectedCommit: main.candidateCommit, candidateCommit: f.initial, candidateTree: initialTree, authorizationId: "e".repeat(64) }))).rejects.toThrow(/does not descend/);
    }
    const next = await configure(f, "refs/heads/development");
    expect(next.status, await next.clone().text()).toBe(200);
    const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: "project", repositoryId: "main" });
    expect(target.currentHead.protectedRef).toBe("refs/heads/development");
    expect((await git("/usr/bin/git", ["--git-dir", repository, "symbolic-ref", "HEAD"])).stdout.trim()).toBe("refs/heads/development");
    expect(target.imported.policy.protectedRef).toBe("refs/heads/main");
    await expect(resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: "project", repositoryId: "main", protectedRef: "refs/heads/unmanaged" })).rejects.toThrow(/not managed/);
    await f.service.close();
    restarted = await configuredNativeGitBundleServer(f.options);
    expect(readNativeProjectRootCurrentHeadFromDatabase(restarted.context.runtime.state.database, "project", "main", "refs/heads/main").commit).toBe(main.candidateCommit);
    expect(readNativeProjectRootCurrentHeadFromDatabase(restarted.context.runtime.state.database, "project", "main", "refs/heads/development").commit).toBe(development.candidateCommit);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
it("rejects unrecorded refs and verifies the exact head of every managed branch", async () => {
  const f = await fixture(false);
  const repository = join(f.root, "state/project/main.git");
  try {
    const configured = await configure(f);
    expect(configured.status).toBe(200);
    const runtime = f.service.context.runtime;
    const branchRuntime = { database: runtime.state.database, stateDirectory: f.options.stateDirectory, gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity };
    const database = new DatabaseSync(runtime.state.database);
    try { database.exec("DELETE FROM repository_branch_baseline"); } finally { database.close(); }
    await expect(ensureConfiguredRepositoryBranches(branchRuntime, "project", "main")).rejects.toThrow(/without an authoritative baseline/);
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", "-d", "refs/heads/development"]);
    await ensureConfiguredRepositoryBranches(branchRuntime, "project", "main");
    const input = await candidate(f, "new object\n", "refs/heads/main", f.initial, "b");
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/development", input.candidateCommit]);
    await expect(resolveAuthoritativeNativeRepositoryTarget(f.service.context.runtime, { projectId: "project", repositoryId: "main" })).rejects.toThrow(/could not be resolved/);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("recovers a durable branch-creation intent after Git publication was interrupted", async () => {
  const f = await fixture(false);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    expect((await configure(f)).status).toBe(200);
    const repository = join(f.root, "state/project/main.git");
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", "-d", "refs/heads/development"]);
    await f.service.close();
    restarted = await configuredNativeGitBundleServer(f.options);
    expect(restarted.context.runtime.state.stateFormat).toBe(12);
    expect((await git("/usr/bin/git", ["--git-dir", repository, "rev-parse", "refs/heads/development"])).stdout.trim()).toBe(f.initial);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("imports configured branches together and uses the configured default for bare HEAD and target discovery", async () => {
  const f = await fixture(false, [], undefined, undefined, {}, { defaultRef: "refs/heads/development", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } } });
  try {
    const target = await resolveAuthoritativeNativeRepositoryTarget(f.service.context.runtime, { projectId: "project", repositoryId: "main" });
    expect(target.currentHead).toMatchObject({ protectedRef: "refs/heads/development", commit: f.initial });
    expect((await git("/usr/bin/git", ["--git-dir", target.repository, "symbolic-ref", "HEAD"])).stdout.trim()).toBe("refs/heads/development");
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("rejects a branch baseline rewritten to another branch's transition instead of its import-anchor seed", async () => {
  const f = await fixture(false);
  try {
    expect((await configure(f)).status).toBe(200);
    const development = await candidate(f, "development branch seed must not be adopted\n", "refs/heads/development", f.initial, "b");
    await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, development));
    expect((await configure(f, "refs/heads/main", { "refs/heads/release": { review: true } })).status).toBe(200);
    const database = new DatabaseSync(f.service.context.runtime.state.database);
    try { database.prepare("UPDATE repository_branch_baseline SET seed_sequence=1,seed_commit=?,seed_tree=? WHERE protected_ref='refs/heads/release'").run(development.candidateCommit, development.candidateTree); }
    finally { database.close(); }
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(f.service.context.runtime.state.database, "project", "main", "refs/heads/release")).toThrow(/no authoritative seed/);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
