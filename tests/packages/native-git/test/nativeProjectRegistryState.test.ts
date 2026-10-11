import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeNativeGitBundleState,
  inspectNativeGitBundleState,
  NativeProjectRegistrationConflictError,
  readNativeProjectRegistrations,
  registerNativeProject
} from "../../../../core/packages/native-git/src/native-bundle-state.js";

const roots: string[] = [];
const projectA = { serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root", ownerHostId: "host-a" } as const;
const projectB = { serviceId: "native-main", projectId: "project-b", rootRepositoryId: "root", ownerHostId: "host-b" } as const;
const generationId = "a".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Project registry state", () => {
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
    expect(inspected).toEqual({ stateFormat: 8 });
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

  it("rejects changed tuple reuse without changing the exact registration", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    activate(state);
    registerNativeProject(state, generationId, projectA);
    const before = await stateTree(root);

    // When
    const changed = () => registerNativeProject(state, generationId, { ...projectA, rootRepositoryId: "other-root" });

    // Then
    expect(changed).toThrow(NativeProjectRegistrationConflictError);
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
  ])("rejects %s byte-identically during read-only inspection", async (_label, serviceId, projectId, rootRepositoryId) => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(`INSERT INTO native_project_registration
      (service_id, project_id, root_repository_id, owner_host_id, provisioning_nonce, phase)
      VALUES (?, ?, ?, ?, ?, ?)`
    ).run(serviceId, projectId, rootRepositoryId, "host-a", "00000000-0000-4000-8000-000000000000", "provisioning");
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
