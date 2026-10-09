import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateFinalizeService,
  activateFinalizeServiceForGeneration,
  activationTokenB,
  authorization,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationB,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootReadIssuerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService,
  startFinalizeServiceForGeneration,
  uploadRootBundle,
  type ImportReceipt,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native root import serving-generation rollover", () => {
  it("serves an unchanged generation-A import only after exact generation-B activation", async () => {
    // Given
    const fixture = await finalizedGenerationA("rollover");
    await closeFinalizeService(fixture.service);
    const before = await importArtifacts(fixture.root, fixture.receipt);

    // When
    const servingB = await startFinalizeServiceForGeneration(
      fixture.root, generationB, activationTokenB
    );

    // Then
    expect(await importArtifacts(fixture.root, fixture.receipt)).toEqual(before);
    expect((await rootProof(servingB.origin)).status).toBe(503);
    expect((await rootLease(servingB.origin, generationB)).status).toBe(503);
    expect((await activate(servingB.origin, generationB, Buffer.alloc(32, 42).toString("base64url"))).status)
      .toBe(404);
    await activateFinalizeServiceForGeneration(servingB.origin, generationB, activationTokenB);
    expect(await (await rootProof(servingB.origin)).json()).toEqual({
      schemaVersion: 3,
      servingGenerationId: generationB,
      ownerHostId: importer.hostId,
      importReceipt: { ...fixture.receipt, resolvedTree: fixture.bundle.tree, phase: "root-imported" },
      currentHead: { projectId: "project-a", sequence: 0, protectedRef: "refs/heads/main",
        commit: fixture.receipt.expectedCommit, tree: fixture.bundle.tree,
        policyDigest: fixture.receipt.policyDigest }
    });
    expect((await rootLease(servingB.origin, generationId)).status).toBe(409);
    expect((await rootLease(servingB.origin, generationB)).status).toBe(201);
    expect(await importArtifacts(fixture.root, fixture.receipt)).toEqual(before);

    await closeFinalizeService(servingB);
    const restartedB = await startFinalizeServiceForGeneration(
      fixture.root, generationB, activationTokenB
    );
    expect((await rootProof(restartedB.origin)).status).toBe(200);
    expect(await importArtifacts(fixture.root, fixture.receipt)).toEqual(before);
  });

  it.each(["foreign ref", "corrupt graph"] as const)(
    "rejects a generation-B startup with a %s without changing import artifacts",
    async (failure) => {
      // Given
      const fixture = await finalizedGenerationA(`rollover-${failure.replace(" ", "-")}`);
      await closeFinalizeService(fixture.service);
      if (failure === "foreign ref") {
        await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref",
          "refs/heads/foreign", fixture.bundle.commit, "0".repeat(40)]);
      } else {
        const packDirectory = join(rootRepository(fixture.root), "objects", "pack");
        const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
        if (pack === undefined) throw new TestSetupError("imported root has no pack fixture");
        await writeFile(join(packDirectory, pack), "corrupt graph", { mode: 0o444 });
      }
      const before = await importArtifacts(fixture.root, fixture.receipt);

      // When / Then
      await expect(startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB))
        .rejects.toThrow(/owner|storage|root|graph|import/i);
      expect(await importArtifacts(fixture.root, fixture.receipt)).toEqual(before);
    }
  );

  it.each(["intent", "bundle-durable", "installing", "objects-installed"] as const)(
    "rejects an earlier-generation %s import before mutating recovery",
    async (phase) => {
      // Given
      const fixture = phase === "objects-installed"
        ? await finalizedGenerationA(`rollover-incomplete-${phase}`)
        : await durableGenerationA(`rollover-incomplete-${phase}`);
      await closeFinalizeService(fixture.service);
      const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
      if (phase === "intent") {
        database.prepare(`UPDATE native_project_root_import SET phase = 'intent',
          bundle_sha256 = NULL, bundle_size = NULL`).run();
      } else if (phase === "installing") {
        database.prepare("UPDATE native_project_root_import SET phase = 'installing'").run();
      } else if (phase === "objects-installed") {
        database.prepare("UPDATE native_project_root_import SET phase = 'objects-installed'").run();
      }
      database.close();
      const before = await importArtifacts(fixture.root, fixture.receipt);

      // When / Then
      await expect(startFinalizeServiceForGeneration(fixture.root, generationB, activationTokenB))
        .rejects.toThrow(/another generation/i);
      expect(await importArtifacts(fixture.root, fixture.receipt)).toEqual(before);
    }
  );
});

async function finalizedGenerationA(label: string) {
  const fixture = await durableGenerationA(label);
  expect((await finalizeRootImport(fixture.service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: fixture.receipt.importNonce,
    bundleDigest: fixture.receipt.bundleDigest
  })).status).toBe(200);
  return fixture;
}

async function durableGenerationA(label: string): Promise<{
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
  return { root, bundle, receipt, service };
}

async function importArtifacts(root: string, receipt: ImportReceipt): Promise<{
  readonly importRow: unknown;
  readonly bundle: Buffer;
  readonly protectedRef: Buffer;
}> {
  const refPath = join(rootRepository(root), "refs", "heads", "main");
  const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
  const importRow = database.prepare("SELECT * FROM native_project_root_import").get();
  database.close();
  const [bundle, protectedRef] = await Promise.all([
    readFile(join(root, "project-a", ".dim-root-import", `${receipt.importNonce}.bundle`)),
    readFile(refPath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    })
  ]);
  return { importRow, bundle, protectedRef };
}

function rootProof(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/root-import/proof`, {
    headers: { authorization }
  });
}

function rootLease(origin: string, requestedGeneration: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/root-read-leases`, {
    method: "POST",
    headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: requestedGeneration })
  });
}

function activate(origin: string, requestedGeneration: string, token: string): Promise<Response> {
  return fetch(`${origin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: requestedGeneration })
  });
}

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
