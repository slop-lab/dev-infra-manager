import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
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
  wrongHostAuthorization,
  type ImportReceipt,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project imported root proof", () => {
  it("returns the exact persisted and live proof before and after restart without changing owned bytes", async () => {
    // Given
    const fixture = await finalizedFixture("proof-restart");

    // When
    const first = await proof(fixture.service.origin, "project-a", authorization);

    // Then
    await expectExactProof(first, fixture.receipt, fixture.bundle.tree);
    await expectProofLeavesOwnedBytesUnchanged(fixture.root, fixture.receipt, async () => {
      await expectExactProof(
        await proof(fixture.service.origin, "project-a", authorization),
        fixture.receipt,
        fixture.bundle.tree
      );
    });

    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);
    await expectProofLeavesOwnedBytesUnchanged(fixture.root, fixture.receipt, async () => {
      await expectExactProof(
        await proof(restarted.origin, "project-a", authorization),
        fixture.receipt,
        fixture.bundle.tree
      );
    });
  });

  it("restarts and proves a completed legacy import without accepting it as current kind authority", async () => {
    // Given
    const fixture = await finalizedFixture("proof-legacy-quarantine");
    await closeFinalizeService(fixture.service);
    const legacyPolicy = {
      protectedRef: "refs/heads/main", policyRevision: "policy-1", requiredReviewRevision: "reviews-1",
      requiredJobSetRevision: "jobs-1", requiredJobNames: ["source"], requiredReviewerIds: ["owner"],
      pathReviewerRules: []
    } as const;
    const policyJson = JSON.stringify(legacyPolicy);
    const legacyDigest = createHash("sha256").update(policyJson).digest("hex");
    const databasePath = join(fixture.root, "native-idle.sqlite3");
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE native_project_root_import SET policy_json = ?, policy_sha256 = ?")
      .run(policyJson, legacyDigest);
    database.close();
    const restarted = await startFinalizeService(fixture.root);
    const expectedReceipt = { ...fixture.receipt, policyDigest: legacyDigest };
    const before = await readFile(databasePath);

    // When
    const legacyProof = await proof(restarted.origin, "project-a", authorization);
    const replay = await uploadRootBundle(restarted.origin, fixture.bundle);

    // Then
    await expectExactProof(legacyProof, expectedReceipt, fixture.bundle.tree);
    expect(replay.status).toBe(409);
    expect(await readFile(databasePath)).toEqual(before);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(fixture.bundle.commit);
  });

  it.each([
    ["unknown credential", `Basic ${Buffer.from("unknown:credential").toString("base64")}`, "project-a", 401],
    ["known wrong role", basic("registrar-a", bundleSecrets.projectRegistrar), "project-a", 403],
    ["foreign importer", wrongHostAuthorization, "project-a", 404],
    ["unknown Project", authorization, "project-missing", 404]
  ] as const)("denies a %s", async (_label, suppliedAuthorization, projectId, status) => {
    // Given
    const fixture = await finalizedFixture("proof-denial");

    // When
    const response = await expectProofLeavesOwnedBytesUnchanged(fixture.root, fixture.receipt,
      () => proof(fixture.service.origin, projectId, suppliedAuthorization));

    // Then
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns unavailable before exact activation", async () => {
    // Given
    const root = await createFinalizeRoot("proof-inactive");
    const service = await startFinalizeService(root);

    // When
    const response = await proof(service.origin, "project-a", authorization);

    // Then
    expect(response.status).toBe(503);
  });

  it("refuses live proof when the durable activation binding changes after startup", async () => {
    const fixture = await finalizedFixture("proof-activation-drift");
    const database = new DatabaseSync(join(fixture.root, "native-idle.sqlite3"));
    try {
      database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ? WHERE generation_id = ?")
        .run("f".repeat(64), generationId);
    } finally {
      database.close();
    }

    const response = await expectProofLeavesOwnedBytesUnchanged(fixture.root, fixture.receipt,
      () => proof(fixture.service.origin, "project-a", authorization));

    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("projectId");
  });

  it.each([
    ["query", (origin: string) => fetch(`${origin}/v1/projects/project-a/root-import/proof?view=live`, {
      headers: { authorization }
    })],
    ["alternate method", (origin: string) => fetch(`${origin}/v1/projects/project-a/root-import/proof`, {
      method: "POST", headers: { authorization }
    })]
  ] as const)("returns not found for an exact-path %s variant", async (_label, request) => {
    // Given
    const fixture = await finalizedFixture("proof-routing");

    // When
    const response = await expectProofLeavesOwnedBytesUnchanged(fixture.root, fixture.receipt,
      () => request(fixture.service.origin));

    // Then
    expect(response.status).toBe(404);
  });

  it.each([
    ["query", (origin: string) => fetch(`${origin}/v1/projects/project-a/root-import/proof?view=live`, {
      headers: { authorization }
    })],
    ["alternate method", (origin: string) => fetch(`${origin}/v1/projects/project-a/root-import/proof`, {
      method: "POST", headers: { authorization }
    })]
  ] as const)("conceals an inactive exact-path %s variant", async (_label, request) => {
    // Given
    const root = await createFinalizeRoot("proof-inactive-routing");
    const service = await startFinalizeService(root);

    // When
    const response = await request(service.origin);

    // Then
    expect(response.status).toBe(404);
  });

  it("does not prove an incomplete durable import", async () => {
    // Given
    const root = await createFinalizeRoot("proof-incomplete");
    const bundle = await createRootBundle();
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    expect((await uploadRootBundle(service.origin, bundle)).status).toBe(200);

    // When
    const response = await proof(service.origin, "project-a", authorization);

    // Then
    expect(response.status).not.toBe(200);
  });

  it.each(["moved ref", "foreign ref", "corrupt bundle", "corrupt graph",
    "repository symlink", "missing owner marker"] as const)(
    "does not prove a %s",
    async (failure) => {
      // Given
      const fixture = await finalizedFixture(`proof-${failure.replace(" ", "-")}`);
      const repository = rootRepository(fixture.root);
      if (failure === "moved ref") {
        const movedCommit = (await runGit("/usr/bin/git", ["--git-dir", repository,
          "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
          "commit-tree", fixture.bundle.tree, "-m", "moved root"])).stdout.trim();
        await runGit("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/main",
          movedCommit, fixture.bundle.commit]);
      } else if (failure === "foreign ref") {
        await runGit("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/foreign",
          fixture.bundle.commit, "0".repeat(40)]);
      } else if (failure === "corrupt bundle") {
        const path = bundlePath(fixture.root, fixture.receipt);
        const bytes = await readFile(path);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
        await writeFile(path, bytes, { mode: 0o600 });
      } else if (failure === "repository symlink") {
        const displaced = join(fixture.root, "detached-root.git");
        await rename(repository, displaced);
        await symlink(displaced, repository);
      } else if (failure === "missing owner marker") {
        await rm(join(fixture.root, "project-a", ".dim-native-project-owner"));
      } else {
        const packDirectory = join(repository, "objects", "pack");
        const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
        if (pack === undefined) throw new Error("imported root has no pack fixture");
        await writeFile(join(packDirectory, pack), "corrupt graph", { mode: 0o444 });
      }

      // When
      const response = await expectProofLeavesOwnedBytesUnchanged(fixture.root, fixture.receipt,
        () => proof(fixture.service.origin, "project-a", authorization));

      // Then
      if (failure === "repository symlink" || failure === "missing owner marker") {
        expect(response.status).toBe(409);
      } else {
        expect(response.status).not.toBe(200);
      }
    }
  );
});

async function finalizedFixture(label: string): Promise<{
  readonly root: string;
  readonly bundle: Awaited<ReturnType<typeof createRootBundle>>;
  readonly service: RunningService;
  readonly receipt: ImportReceipt;
}> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  const finalized = await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  });
  expect(finalized.status).toBe(200);
  return { root, bundle, service, receipt };
}

async function expectExactProof(response: Response, receipt: ImportReceipt, resolvedTree: string): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    schemaVersion: 3,
    servingGenerationId: generationId,
    ownerHostId: importer.hostId,
    importReceipt: { ...receipt, resolvedTree, phase: "root-imported" },
    currentHead: { projectId: "project-a", sequence: 0, protectedRef: "refs/heads/main",
      commit: receipt.expectedCommit, tree: resolvedTree, policyDigest: receipt.policyDigest }
  });
}

async function expectProofLeavesOwnedBytesUnchanged<T>(
  root: string,
  receipt: ImportReceipt,
  request: () => Promise<T>
): Promise<T> {
  const paths = [
    join(root, "native-idle.sqlite3"),
    bundlePath(root, receipt),
    join(rootRepository(root), "refs", "heads", "main")
  ];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  const result = await request();
  const after = await Promise.all(paths.map((path) => readFile(path)));
  expect(after).toEqual(before);
  return result;
}

function proof(origin: string, projectId: string, suppliedAuthorization: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/${projectId}/root-import/proof`, {
    headers: { authorization: suppliedAuthorization }
  });
}

function bundlePath(root: string, receipt: ImportReceipt): string {
  return join(root, "project-a", ".dim-root-import", `${receipt.importNonce}.bundle`);
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
