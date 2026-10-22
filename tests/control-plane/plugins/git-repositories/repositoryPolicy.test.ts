import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { compareAndSwapProtectedRef, refUpdatePolicyExtension, type RefUpdatePolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { fixture, basic, generationId, git, record, reviewer, text, token } from "./optionalFeaturesFixture.js";

const importer = { username: "importer", password: token(1) };
const headers = { authorization: basic(importer), "x-dim-generation-id": generationId, "content-type": "application/json" };
const path = "/v1/projects/project/repositories/main/policy";
function policy(extensions: Readonly<Record<string, unknown>>, protectedRef = "refs/heads/main") {
  return { schemaVersion: 1, protectedRef, policyRevision: nativeRepositoryPolicyRevision({ protectedRef, extensions }), extensions };
}
async function current(origin: string) { const response = await fetch(`${origin}${path}`, { headers }); expect(response.status, await response.clone().text()).toBe(200); return record(await response.json()); }
async function update(origin: string, previous: Record<string, unknown>, next: unknown, overrides: object = {}) {
  return fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: record(previous.currentHead).commit, policy: next, ...overrides }) });
}
function guard(): RefUpdatePolicy { return { name: "custom", revision: "a".repeat(64), validate(options) { if (typeof record(options).deny !== "boolean") throw new Error("deny must be boolean"); }, async check({ options }) { if (record(options).deny === true) throw new Error("custom denies this update"); } }; }
async function candidate(f: Awaited<ReturnType<typeof fixture>>, content: string, expectedCommit: string, id: string) {
  await writeFile(join(f.source, "README.md"), content);
  const candidateCommit = await f.commit();
  await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
  const candidateTree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  return { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef, expectedCommit, candidateCommit, candidateTree, authorizationId: id.repeat(64), evidenceDigest: "c".repeat(64) };
}

it("updates live policy without rewriting import receipts or ref history, preserves workspace pushes and survives restart", async () => {
  const f = await fixture(false, [refUpdatePolicyExtension(guard())]);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const original = await current(f.origin);
    const proof = () => fetch(`${f.origin}/v1/projects/project/repositories/main/import/proof`, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, generationId }) }).then(async (response) => { expect(response.status).toBe(200); return record(await response.json()); });
    const originalReceipt = (await proof()).importReceipt;
    const first = await candidate(f, "first\n", f.initial, "b");
    expect(await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, first))).toMatchObject({ sequence: 1 });
    const afterFirst = await current(f.origin);
    expect(record(afterFirst.currentHead).commit).toBe(first.candidateCommit);
    const changed = await update(f.origin, afterFirst, policy({ custom: { deny: true } }));
    expect(changed.status, await changed.clone().text()).toBe(200);
    const denied = record(await changed.json());
    expect(denied.policyDigest).not.toBe(original.policyDigest);
    const second = await candidate(f, "second\n", first.candidateCommit, "d");
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, second))).rejects.toThrow(/custom denies/);
    const allowed = await update(f.origin, denied, policy({ custom: { deny: false } }));
    expect(allowed.status).toBe(200);
    expect(await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, second))).toMatchObject({ sequence: 2 });
    const final = await current(f.origin);
    const receipt = await proof();
    expect(receipt.importReceipt).toEqual(originalReceipt);
    expect(record(receipt.currentHead)).toMatchObject({ sequence: 2, commit: second.candidateCommit, policyDigest: final.policyDigest });
    const bareHead = (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "main"])).stdout.trim();
    expect(bareHead).toBe(second.candidateCommit);
    await f.service.close();
    await expect(configuredNativeGitBundleServer({ ...f.options, extensions: [] })).rejects.toThrow(/requires an enabled custom plugin/);
    restarted = await configuredNativeGitBundleServer(f.options);
    const origin = await restarted.listen("127.0.0.1", 0);
    expect(await current(origin)).toEqual(final);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("validates extension owners and schemas, exact policy/head CAS and unchanged protected ref before persisting", async () => {
  const f = await fixture(false, [refUpdatePolicyExtension(guard())]);
  try {
    const before = await current(f.origin);
    const rejected = [
      { next: policy({ custom: { deny: false } }), overrides: { expectedPolicyDigest: "f".repeat(64) }, status: 409 },
      { next: policy({ custom: { deny: false } }), overrides: { expectedProtectedHead: "f".repeat(40) }, status: 409 },
      { next: policy({}, "refs/heads/other"), status: 409 },
      { next: policy({ custom: { deny: "yes" } }), status: 400 },
      { next: policy({ "not-installed": {} }), status: 400 },
      { next: { ...policy({}), policyRevision: "f".repeat(64) }, status: 400 }
    ];
    for (const input of rejected) {
      const response = await update(f.origin, before, input.next, input.overrides);
      expect(response.status, await response.clone().text()).toBe(input.status);
      expect(await current(f.origin)).toEqual(before);
    }
    const success = await update(f.origin, before, policy({ custom: { deny: false } }));
    expect(success.status).toBe(200);
    const after = record(await success.json());
    expect((await update(f.origin, before, policy({}))).status).toBe(409);
    expect((await update(f.origin, after, after.policy)).status).toBe(200);
    const database = new DatabaseSync(join(f.root, "state/native-idle.sqlite3"), { readOnly: true });
    try { expect(database.prepare("SELECT count(*) AS count FROM repository_policy_update").get()).toEqual({ count: 1 }); } finally { database.close(); }
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("restricts policy reads and writes to generation-bound importer authority", async () => {
  const f = await fixture(false);
  try {
    expect((await fetch(`${f.origin}${path}`)).status).toBe(401);
    expect((await fetch(`${f.origin}${path}`, { headers: { ...headers, authorization: basic({ username: "writer", password: token(2) }) } })).status).toBe(403);
    expect((await fetch(`${f.origin}${path}`, { headers: { ...headers, "x-dim-generation-id": "b".repeat(64) } })).status).toBe(409);
    expect((await fetch(`${f.origin}${path.replace("project/", "other/")}`, { headers })).status).toBe(404);
    expect((await fetch(`${f.origin}${path}?ignored=yes`, { headers })).status).toBe(404);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});

it.each(["normal", "unknown-entry", "database-symlink", "marker-publication-interrupted"] as const)("safely upgrades format 10 without losing receipts/ref history (%s)", async (scenario) => {
  const f = await fixture(false);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const first = await candidate(f, "before upgrade\n", f.initial, "b");
    await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, first));
    const before = await current(f.origin);
    await f.service.close();
    const databasePath = join(f.root, "state/native-idle.sqlite3");
    const database = new DatabaseSync(databasePath);
    let manifest: string;
    try {
      database.exec("DROP TABLE repository_branch_baseline; DROP TABLE repository_policy_update; PRAGMA user_version=10;");
      const names = ["bundle_activation", "native_project_registration", "native_repository_registration", "native_project_root_import", "repository_ref_transition"];
      manifest = `sha256:${createHash("sha256").update(`10\n${names.map((name) => text(record(database.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)), "sql").replace(/\s+/g, " ").trim()).join("\n")}\n`).digest("hex")}`;
    } finally { database.close(); }
    const markerPath = join(f.root, "state/state-format.json");
    const marker = record(JSON.parse(await readFile(markerPath, "utf8")));
    await chmod(markerPath, 0o600);
    await writeFile(markerPath, JSON.stringify({ ...marker, stateFormat: 10, schemaManifestSha256: manifest }));
    await chmod(markerPath, 0o444);
    if (scenario === "unknown-entry") {
      await writeFile(join(f.root, "state/unowned.txt"), "foreign\n");
      const bytes = await readFile(databasePath);
      await expect(configuredNativeGitBundleServer(f.options)).rejects.toThrow(/unknown native Git state entry/);
      expect(await readFile(databasePath)).toEqual(bytes);
      expect(record(JSON.parse(await readFile(markerPath, "utf8"))).stateFormat).toBe(10);
      return;
    }
    if (scenario === "database-symlink") {
      const foreignPath = join(f.root, "foreign.sqlite3");
      await rename(databasePath, foreignPath);
      await symlink(foreignPath, databasePath);
      const bytes = await readFile(foreignPath);
      await expect(configuredNativeGitBundleServer(f.options)).rejects.toThrow();
      expect(await readFile(foreignPath)).toEqual(bytes);
      return;
    }
    const { inspectNativeGitBundleState } = await import("../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js");
    const oldBytes = await readFile(databasePath);
    expect(await inspectNativeGitBundleState(join(f.root, "state"))).toEqual({ stateFormat: 10 });
    expect(await readFile(databasePath)).toEqual(oldBytes);
    if (scenario === "marker-publication-interrupted") {
      const { repositoryPolicyUpdateSchema } = await import("../../../../packages/control-plane/plugins/git-repositories/src/repository-policy-state.js");
      const migrated = new DatabaseSync(databasePath);
      try { migrated.exec(`${repositoryPolicyUpdateSchema}; PRAGMA user_version=11;`); } finally { migrated.close(); }
    }
    restarted = await configuredNativeGitBundleServer(f.options);
    const origin = await restarted.listen("127.0.0.1", 0);
    expect(await current(origin)).toEqual(before);
    expect(record(JSON.parse(await readFile(markerPath, "utf8"))).stateFormat).toBe(12);
    expect((await update(origin, before, before.policy)).status).toBe(200);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);


it("requires fresh review after policy replacement even when the candidate and required reviewer stay the same", async () => {
  const f = await fixture(true);
  try {
    const input = await candidate(f, "requires review\n", f.initial, "b");
    const reviewHeaders = { ...headers, authorization: basic(reviewer) };
    const resolve = () => fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/resolve`, { method: "POST", headers: reviewHeaders, body: JSON.stringify({ schemaVersion: 1, proposalRef: f.proposalRef }) }).then(async (response) => { expect(response.status, await response.clone().text()).toBe(200); return record(await response.json()); });
    const approve = async (envelope: Record<string, unknown>) => {
      const reviewId = text(record(envelope.review), "reviewId");
      const response = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/${reviewId}/approvals`, { method: "POST", headers: reviewHeaders, body: JSON.stringify({ requestId: randomUUID() }) });
      expect(response.status, await response.clone().text()).toBe(201);
    };
    const oldReview = await resolve();
    await approve(oldReview);
    const before = await current(f.origin);
    const response = await update(f.origin, before, policy({ "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [{ pathPrefix: "README.md", reviewerIds: ["owner"] }] } }));
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, input))).rejects.toThrow(/every required human approval/);
    const fresh = await resolve();
    expect(text(record(fresh.review), "reviewId")).not.toBe(text(record(oldReview.review), "reviewId"));
    await approve(fresh);
    expect(await f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, input))).toMatchObject({ sequence: 1 });
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("hides another host's repository from an authenticated importer", async () => {
  const f = await fixture(false);
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    await f.service.close();
    const foreign = { hostId: "host-b", username: "foreign-importer", password: token(7) };
    restarted = await configuredNativeGitBundleServer({ ...f.options, config: { ...f.options.config, projectRootImporters: [{ ...importer, hostId: "host-a" }, foreign] } });
    const origin = await restarted.listen("127.0.0.1", 0);
    expect((await fetch(`${origin}${path}`, { headers: { ...headers, authorization: basic(foreign) } })).status).toBe(404);
    const before = await current(origin);
    expect((await fetch(`${origin}${path}`, { method: "POST", headers: { ...headers, authorization: basic(foreign) }, body: JSON.stringify({ schemaVersion: 1, expectedPolicyDigest: before.policyDigest, expectedProtectedHead: record(before.currentHead).commit, policy: before.policy }) })).status).toBe(404);
    expect(await current(origin)).toEqual(before);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
