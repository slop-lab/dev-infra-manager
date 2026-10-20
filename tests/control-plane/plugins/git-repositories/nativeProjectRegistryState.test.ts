import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeNativeGitBundleState,
  inspectNativeGitBundleState,
  readNativeProjectRegistrations,
  registerNativeProject
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js";

const roots: string[] = [];
const projectA = { serviceId: "native-main", projectId: "project-a", repositoryId: "root", ownerHostId: "host-a" } as const;
const projectB = { serviceId: "native-main", projectId: "project-b", repositoryId: "root", ownerHostId: "host-b" } as const;
const generationId = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Project registry state", () => {
  it("registers independent repositories under one Project owner and durable storage identity", async () => {
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root); activate(state);
    try {
      registerNativeProject(state, generationId, { ...projectA, repositoryId: "public" });
      registerNativeProject(state, generationId, { ...projectA, repositoryId: "private" });
      const repositories = readNativeProjectRegistrations(state);
      expect(repositories.map(({ repositoryId }) => repositoryId)).toEqual(["private", "public"]);
      expect(new Set(repositories.map(({ provisioningNonce }) => provisioningNonce)).size).toBe(1);
      const before = await stateTree(root);
      expect(() => registerNativeProject(state, generationId, { ...projectA, repositoryId: "third", ownerHostId: "host-b" })).toThrow(/host does not match/);
      expect(await stateTree(root)).toEqual(before);
    } finally { await state.owner.release(); }
    await expect(inspectNativeGitBundleState(root)).resolves.toEqual({ stateFormat: 10 });
  });
  it("refuses registration before the installed generation is activated", async () => {
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    const before = await stateTree(root);

    try {
      expect(() => registerNativeProject(state, generationId, projectA)).toThrow(/activation/);
      expect(await stateTree(root)).toEqual(before);
    } finally {
      await state.owner.release();
    }
  });

  it("persists two Project/root identities across restart and read-only inspection", async () => {
    // Given
    const root = await temporaryRoot();
    const initial = await initializeNativeGitBundleState(root);
    activate(initial);
    registerNativeProject(initial, generationId, projectA);
    registerNativeProject(initial, generationId, projectB);
    await initial.owner.release();
    const beforeInspection = await stateTree(root);

    // When
    const inspected = await inspectNativeGitBundleState(root);
    const restarted = await initializeNativeGitBundleState(root);
    const registrations = readNativeProjectRegistrations(restarted);
    await restarted.owner.release();

    // Then
    expect(inspected).toEqual({ stateFormat: 10 });
    expect(registrations).toEqual([
      expect.objectContaining({ ...projectA, phase: "provisioning", provisioningNonce: expect.any(String) }),
      expect.objectContaining({ ...projectB, phase: "provisioning", provisioningNonce: expect.any(String) })
    ]);
    expect(await stateTree(root)).toEqual(beforeInspection);
  });

  it("converges an exact registration replay without changing state", async () => {
    // Given
    const root = await temporaryRoot();
    const initial = await initializeNativeGitBundleState(root);
    activate(initial);
    registerNativeProject(initial, generationId, projectA);
    await initial.owner.release();
    const state = await initializeNativeGitBundleState(root);
    const before = await stateTree(root);

    // When
    registerNativeProject(state, generationId, projectA);

    // Then
    expect(readNativeProjectRegistrations(state)).toEqual([
      expect.objectContaining({ ...projectA, phase: "provisioning", provisioningNonce: expect.any(String) })
    ]);
    expect(await stateTree(root)).toEqual(before);
    await state.owner.release();
  });

  it("rejects another owner without changing the Project registration", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    activate(state);
    registerNativeProject(state, generationId, projectA);
    const before = await stateTree(root);

    // When
    const changed = () => registerNativeProject(state, generationId, { ...projectA, ownerHostId: "host-b" });

    // Then
    expect(changed).toThrow(/host does not match/);
    expect(readNativeProjectRegistrations(state)).toEqual([
      expect.objectContaining({ ...projectA, phase: "provisioning", provisioningNonce: expect.any(String) })
    ]);
    expect(await stateTree(root)).toEqual(before);
    await state.owner.release();
  });

  it("requires a live storage-owner lock for mutation", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();

    // When
    const register = () => registerNativeProject(state, generationId, projectA);

    // Then
    expect(register).toThrow(/storage owner/i);
  });

  it("rejects a different activation generation before an exact registration", async () => {
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    activate(state);
    const before = await stateTree(root);

    expect(() => registerNativeProject(state, "c".repeat(64), projectA)).toThrow(/activation/);
    expect(await stateTree(root)).toEqual(before);
    await state.owner.release();
  });

  it.each([
    ["a malformed row", "native-main", "INVALID", "root"],
    ["a foreign row", "foreign-native", "project-a", "root"]
  ])("rejects %s byte-identically during read-only inspection", async (_label, serviceId, projectId, repositoryId) => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(`INSERT INTO native_project_registration
      (service_id, project_id, owner_host_id, provisioning_nonce)
      VALUES (?, ?, ?, ?)`
    ).run(serviceId, projectId, "host-a", "00000000-0000-4000-8000-000000000000");
    database.prepare("INSERT INTO native_repository_registration (project_id, repository_id, phase) VALUES (?, ?, 'provisioning')").run(projectId, repositoryId);
    database.close();
    const before = await stateTree(root);

    // When
    const inspect = inspectNativeGitBundleState(root);

    // Then
    await expect(inspect).rejects.toThrow(/registration/i);
    await expect(initializeNativeGitBundleState(root)).rejects.toThrow(/registration/i);
    expect(await stateTree(root)).toEqual(before);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-project-registry-"));
  roots.push(root);
  return root;
}

function activate(state: Awaited<ReturnType<typeof initializeNativeGitBundleState>>): void {
  const database = new DatabaseSync(state.database);
  try {
    database.prepare("INSERT INTO bundle_activation (generation_id, activation_token_sha256) VALUES (?, ?)")
      .run(generationId, "b".repeat(64));
  } finally {
    database.close();
  }
}

async function stateTree(root: string): Promise<readonly StateTreeEntry[]> {
  return Promise.all((await readdir(root)).sort().map(async (entry) => {
    const path = join(root, entry);
    const metadata = await stat(path, { bigint: true });
    return { entry, bytes: await readFile(path), mtimeNanoseconds: metadata.mtimeNs };
  }));
}

type StateTreeEntry = {
  readonly entry: string;
  readonly bytes: Buffer;
  readonly mtimeNanoseconds: bigint;
};
