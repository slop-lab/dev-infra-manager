import { gitPolicy } from "../../../support/git-policy.js";
import { realGitVersion } from "./realGitIdentity.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNativeProjectRootImport,
  initializeNativeGitBundleState,
  inspectNativeGitBundleState,
  markNativeProjectRootBundleDurable,
  registerNativeProject
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js";
import {
  activationTokenSha256,
  bindExactActivation
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-activation.js";
import { executeNativeProjectPreparation } from "../../../../packages/control-plane/plugins/git-repositories/src/native-project-registration.js";
import { rootBundlePath } from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-import-storage.js";
import { refValue } from "../../../support/gitHelpers.js";

const roots: string[] = [];
const generationId = "a".repeat(64);
const otherGenerationId = "b".repeat(64);
const project = { serviceId: "native-main", projectId: "project-a", repositoryId: "root" } as const;
const policy = gitPolicy();
const intent = {
  ...project,
  protectedRef: policy.protectedRef,
  expectedCommit: "c".repeat(40),
  policy
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Project root import intent state", () => {
  it("claims one canonical intent and replays its nonce and digest across restart without creating a ref", async () => {
    const root = await temporaryRoot();
    const initial = await preparedState(root);
    const claimed = claimNativeProjectRootImport(initial, generationId, "host-a", intent);
    await initial.owner.release();

    const restarted = await initializeNativeGitBundleState(root);
    const replayed = claimNativeProjectRootImport(restarted, generationId, "host-a", {
      ...intent,
      policy: { extensions: policy.extensions, policyRevision: policy.policyRevision,
        protectedRef: policy.protectedRef, schemaVersion: 1 }
    });

    expect(replayed).toEqual(claimed);
    expect(claimed).toMatchObject({
      ...project,
      ownerHostId: "host-a",
      generationId,
      protectedRef: "refs/heads/main",
      expectedCommit: "c".repeat(40),
      phase: "intent",
      policy,
      importNonce: expect.any(String),
      policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    const database = new DatabaseSync(restarted.database, { readOnly: true });
    expect(database.prepare(`SELECT service_id, project_id, repository_id, owner_host_id,
      generation_id, protected_ref, expected_commit, policy_sha256, phase
      FROM native_project_root_import`).get()).toEqual({
      service_id: "native-main",
      project_id: "project-a",
      repository_id: "root",
      owner_host_id: "host-a",
      generation_id: generationId,
      protected_ref: "refs/heads/main",
      expected_commit: "c".repeat(40),
      policy_sha256: claimed.policyDigest,
      phase: "intent"
    });
    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE name IN ('native_project_reader', 'native_project_writer')"
    ).all()).toEqual([]);
    expect(database.prepare("SELECT name FROM pragma_table_info('native_project_root_import') ORDER BY cid").all())
      .toEqual([
        "project_id", "service_id", "repository_id", "owner_host_id", "generation_id", "import_nonce",
        "protected_ref", "expected_commit", "policy_json", "policy_sha256", "bundle_sha256", "bundle_size",
        "resolved_tree", "phase"
      ].map((name) => ({ name })));
    database.close();
    expect(await refValue(repository(root), "refs/heads/main")).toBeUndefined();
    await restarted.owner.release();
  });

  it("rejects changed owner, generation, ref, commit, or policy without changing the intent or bare ref", async () => {
    const root = await temporaryRoot();
    const state = await preparedState(root);
    claimNativeProjectRootImport(state, generationId, "host-a", intent);
    bindExactActivation(state, otherGenerationId, activationTokenSha256("d".repeat(43)));
    const databasePath = state.database;
    const before = await databaseSnapshot(databasePath);
    const changed = [
      ["owner", generationId, "host-b", intent],
      ["generation", otherGenerationId, "host-a", intent],
      ["ref", generationId, "host-a", {
        ...intent, protectedRef: "refs/heads/stable", policy: { ...policy, protectedRef: "refs/heads/stable" }
      }],
      ["commit", generationId, "host-a", { ...intent, expectedCommit: "d".repeat(40) }],
      ["policy", generationId, "host-a", {
        ...intent, policy: { ...policy, policyRevision: "policy-2" }
      }],
      ["policy extension", generationId, "host-a", { ...intent,
        policy: gitPolicy({ "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [] } }) }]

    ] as const;

    for (const [_label, requestedGeneration, hostId, requested] of changed) {
      expect(() => claimNativeProjectRootImport(state, requestedGeneration, hostId, requested)).toThrow();
      expect(await databaseSnapshot(databasePath)).toEqual(before);
      expect(await refValue(repository(root), "refs/heads/main")).toBeUndefined();
    }
    await state.owner.release();
  });

  it.each([
    ["unsafe protected ref", { ...intent, protectedRef: "refs/heads/proposals/workspace/change",
      policy: { ...policy, protectedRef: "refs/heads/proposals/workspace/change" } }],
    ["incorrect policy revision", { ...intent, policy: { ...policy, policyRevision: "f".repeat(64) } }],
    ["unowned flat policy fields", { ...intent, policy: { ...policy, requiredReviewerIds: ["owner"] } }],
    ["missing policy extensions", { ...intent, policy: { schemaVersion: 1, protectedRef: policy.protectedRef, policyRevision: policy.policyRevision } }]
  ])("rejects %s at the untrusted intent boundary without mutation", async (_label, requested) => {
    const root = await temporaryRoot();
    const state = await preparedState(root);
    const before = await databaseSnapshot(state.database);

    expect(() => claimNativeProjectRootImport(state, generationId, "host-a", requested)).toThrow();
    expect(await databaseSnapshot(state.database)).toEqual(before);
    expect(await refValue(repository(root), "refs/heads/main")).toBeUndefined();
    await state.owner.release();
  });

  it("requires the registered Project to be repository-prepared", async () => {
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    activate(state);
    registerNativeProject(state, generationId, { ...project, ownerHostId: "host-a" });
    const before = await databaseSnapshot(state.database);

    expect(() => claimNativeProjectRootImport(state, generationId, "host-a", intent)).toThrow(/prepared/i);
    expect(await databaseSnapshot(state.database)).toEqual(before);
    await state.owner.release();
  });

  it("rejects a malformed persisted intent byte-identically during strict inspection", async () => {
    const root = await temporaryRoot();
    const state = await preparedState(root);
    claimNativeProjectRootImport(state, generationId, "host-a", intent);
    await state.owner.release();
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare("UPDATE native_project_root_import SET policy_json = ?").run("{}");
    database.close();
    const before = await readFile(join(root, "native-idle.sqlite3"));

    await expect(inspectNativeGitBundleState(root)).rejects.toThrow(/root import.*(?:intent|policy)/i);
    await expect(initializeNativeGitBundleState(root)).rejects.toThrow(/root import.*(?:intent|policy)/i);
    expect(await readFile(join(root, "native-idle.sqlite3"))).toEqual(before);
  });

  it("advances monotonically to bundle-durable and validates the hash-bound file on restart", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await preparedState(root);
    const claimed = claimNativeProjectRootImport(state, generationId, "host-a", intent);
    const bytes = Buffer.from("durable private bundle bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = rootBundlePath(root, project.projectId, project.repositoryId, claimed.importNonce);
    await mkdir(join(root, project.projectId, ".dim-import-root"), { mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });

    // When
    const durable = markNativeProjectRootBundleDurable(
      state, project.projectId, project.repositoryId, claimed.importNonce, digest, bytes.length
    );
    const replay = markNativeProjectRootBundleDurable(
      state, project.projectId, project.repositoryId, claimed.importNonce, digest, bytes.length
    );
    await state.owner.release();
    const restarted = await initializeNativeGitBundleState(root);

    // Then
    expect(replay).toEqual(durable);
    expect(durable).toMatchObject({ phase: "bundle-durable", bundleDigest: digest, bundleSize: bytes.length });
    expect(() => markNativeProjectRootBundleDurable(
      restarted, project.projectId, project.repositoryId, claimed.importNonce, "d".repeat(64), bytes.length
    )).toThrow(/conflict/i);
    await restarted.owner.release();
    await writeFile(path, "changed", { mode: 0o600 });
    await expect(initializeNativeGitBundleState(root)).rejects.toThrow(/bundle/i);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-state-"));
  roots.push(root);
  return root;
}

async function preparedState(root: string) {
  const state = await initializeNativeGitBundleState(root);
  activate(state);
  await executeNativeProjectPreparation({
    database: state.database,
    stateDirectory: root,
    runtimeConfig: { storageRoot: root, gitExecutable: "/usr/bin/git", gitVersion: realGitVersion },
    generationId,
    ownerHostId: "host-a",
    input: project
  });
  return state;
}

function activate(state: Awaited<ReturnType<typeof initializeNativeGitBundleState>>): void {
  bindExactActivation(state, generationId, activationTokenSha256("c".repeat(43)));
}

function repository(root: string): string {
  return join(root, "project-a", "root.git");
}

async function databaseSnapshot(path: string): Promise<DatabaseSnapshot> {
  const metadata = await stat(path, { bigint: true });
  return { bytes: await readFile(path), mtimeNanoseconds: metadata.mtimeNs };
}

type DatabaseSnapshot = {
  readonly bytes: Buffer;
  readonly mtimeNanoseconds: bigint;
};
