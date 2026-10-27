import { chmod, cp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as rootProofGit from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-import-proof-git.js";
import {
  activateFinalizeService,
  authorization,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  type ImportReceipt,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFinalizeFixtures();
});

describe("native root immutable proof attestation", () => {
  it("reuses one full immutable proof for repeated warm reads", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-warm");
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");

    // When
    const first = await proof(fixture.service.origin);
    const second = await proof(fixture.service.origin);

    // Then
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(proofs).toHaveBeenCalledTimes(1);
  });

  it("invalidates the attestation after in-place bundle tampering", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-bundle-tamper");
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");
    expect((await proof(fixture.service.origin)).status).toBe(200);
    const path = bundlePath(fixture.root, fixture.receipt);
    const bytes = await readFile(path);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await writeFile(path, bytes, { mode: 0o600 });

    // When
    const response = await proof(fixture.service.origin);

    // Then
    expect(response.status).not.toBe(200);
    expect(proofs).toHaveBeenCalledTimes(1);
  });

  it("rejects a live authority change before reusing immutable proof", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-authority-change");
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");
    expect((await proof(fixture.service.origin)).status).toBe(200);
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
    try {
      database.prepare("UPDATE native_project_registration SET owner_host_id = ? WHERE project_id = ?")
        .run("host-b", "project-a");
    } finally {
      database.close();
    }

    // When
    const response = await proof(fixture.service.origin);

    // Then
    expect(response.status).not.toBe(200);
    expect(proofs).toHaveBeenCalledTimes(1);
  });

  it("reproves an inode-for-inode repository replacement", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-replacement");
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");
    expect((await proof(fixture.service.origin)).status).toBe(200);
    const repository = rootRepository(fixture.root);
    const displaced = join(fixture.root, "displaced-root.git");
    await rename(repository, displaced);
    await cp(displaced, repository, { recursive: true, preserveTimestamps: true });

    // When
    const response = await proof(fixture.service.origin);

    // Then
    expect(response.status).toBe(200);
    expect(proofs).toHaveBeenCalledTimes(2);
  });

  it("invalidates the attestation after in-place object tampering", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-object-tamper");
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");
    expect((await proof(fixture.service.origin)).status).toBe(200);
    const packDirectory = join(rootRepository(fixture.root), "objects", "pack");
    const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
    if (pack === undefined) throw new TestSetupError("imported root has no pack fixture");
    const path = join(packDirectory, pack);
    await chmod(path, 0o600);
    await writeFile(path, "corrupt graph");
    await chmod(path, 0o444);

    // When
    const response = await proof(fixture.service.origin);

    // Then
    expect(response.status).not.toBe(200);
    expect(proofs).toHaveBeenCalledTimes(2);
  });

  it("reproves trusted Git object mutations", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-trusted-mutation");
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");
    expect((await proof(fixture.service.origin)).status).toBe(200);
    const repository = rootRepository(fixture.root);
    const commit = (await runGit("/usr/bin/git", ["--git-dir", repository, "-c", "user.name=DIM Test",
      "-c", "user.email=dim@example.invalid", "commit-tree", fixture.bundle.tree,
      "-p", fixture.bundle.commit, "-m", "trusted ordinary mutation"])).stdout.trim();
    await runGit("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/topic", commit]);

    // When
    const response = await proof(fixture.service.origin);

    // Then
    expect(response.status).toBe(200);
    expect(proofs).toHaveBeenCalledTimes(2);
  });

  it("performs a cold immutable proof after process-state restart", async () => {
    // Given
    const fixture = await finalizedFixture("attestation-restart");
    expect((await proof(fixture.service.origin)).status).toBe(200);
    await closeFinalizeService(fixture.service);
    const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");

    // When
    const restarted = await startFinalizeService(fixture.root);
    const startupProofs = proofs.mock.calls.length;
    proofs.mockClear();
    const first = await proof(restarted.origin);
    const second = await proof(restarted.origin);

    // Then
    expect(startupProofs).toBeGreaterThanOrEqual(1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(proofs).not.toHaveBeenCalled();
  });
});

async function finalizedFixture(label: string): Promise<{
  readonly root: string;
  readonly bundle: Awaited<ReturnType<typeof createRootBundle>>;
  readonly receipt: ImportReceipt;
  readonly service: RunningService;
}> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { root, bundle, receipt, service };
}

function proof(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root/import/proof`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
}

function bundlePath(root: string, receipt: ImportReceipt): string {
  return join(root, "project-a", ".dim-import-root", `${receipt.importNonce}.bundle`);
}

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
