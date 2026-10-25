import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseNativeGitProjectAttachment,
  parseNativeGitProjectCatalog
} from "@slop-lab/dim-contracts-git";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import {
  activateFinalizeService,
  authorization,
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootReadIssuerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  wrongHostRootReadIssuer,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project attachment discovery", () => {
  it("returns only fully imported repositories without mutating durable state", async () => {
    // Given
    const root = await createFinalizeRoot("attachment-live");
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    const receipt = await importRepository(service, "root");
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a", "pending"));
    const databasePath = join(root, "native-idle.sqlite3");
    const databaseBefore = await readFile(databasePath);

    // When
    const catalogResponse = await discovery(service.origin, "/v1/projects");
    const descriptorResponse = await discovery(service.origin, "/v1/projects/project-a/attachment");

    // Then
    expect(catalogResponse.status).toBe(200);
    const catalog = parseNativeGitProjectCatalog(await catalogResponse.json());
    expect(catalog).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      generationId,
      ownerHostId: importer.hostId,
      projects: [{ projectId: "project-a", repositoryCount: 1 }]
    });
    expect(descriptorResponse.status).toBe(200);
    const descriptor = parseNativeGitProjectAttachment(await descriptorResponse.json());
    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      serviceId: "native-main",
      generationId,
      ownerHostId: importer.hostId,
      projectId: "project-a",
      repositories: [{
        repositoryId: "root",
        importReceipt: { ...receipt, resolvedTree: expect.any(String), phase: "repository-imported" },
        importedPolicy: { schemaVersion: 1, protectedRef: "refs/heads/main" },
        effectivePolicy: { schemaVersion: 1, protectedRef: "refs/heads/main" },
        currentHead: { projectId: "project-a", repositoryId: "root", sequence: 0 }
      }]
    });
    const repository = descriptor.repositories[0];
    if (repository === undefined) throw new Error("attachment fixture has no repository");
    expect(() => parseNativeGitProjectAttachment({
      ...descriptor,
      repositories: Array.from({ length: 65 }, (_unused, index) => ({
        ...repository,
        repositoryId: `repository-${String(index)}`,
        importReceipt: { ...repository.importReceipt, repositoryId: `repository-${String(index)}` },
        currentHead: { ...repository.currentHead, repositoryId: `repository-${String(index)}` }
      }))
    })).toThrow();
    expect(() => parseNativeGitProjectCatalog({
      ...catalog,
      projects: Array.from({ length: 1_025 }, (_unused, index) => ({
        projectId: `project-${String(index)}`,
        repositoryCount: 1
      }))
    })).toThrow();
    expect(() => parseNativeGitProjectAttachment({
      ...descriptor,
      repositories: [{
        ...repository,
        currentHead: { ...repository.currentHead, repositoryId: "foreign" }
      }]
    })).toThrow();
    expect(() => parseNativeGitProjectAttachment({
      ...descriptor,
      repositories: [{
        ...repository,
        effectivePolicy: { ...repository.effectivePolicy, protectedRef: "refs/heads/other" }
      }]
    })).toThrow();
    const wrongRevisionPolicy = { ...repository.effectivePolicy, policyRevision: "f".repeat(64) };
    expect(() => parseNativeGitProjectAttachment({
      ...descriptor,
      repositories: [{
        ...repository,
        effectivePolicy: wrongRevisionPolicy,
        currentHead: {
          ...repository.currentHead,
          policyDigest: createHash("sha256").update(JSON.stringify(wrongRevisionPolicy)).digest("hex")
        }
      }]
    })).toThrow();
    expect(await readFile(databasePath)).toEqual(databaseBefore);
  });

  it.each([
    ["unknown credential", basic("unknown", Buffer.alloc(32, 90).toString("base64url")), 401],
    ["registrar role", basic("registrar-a", bundleSecrets.projectRegistrar), 403],
    ["importer role", authorization, 403]
  ] as const)("rejects %s", async (_label, suppliedAuthorization, status) => {
    // Given
    const fixture = await importedFixture("attachment-auth");

    // When
    const response = await discovery(fixture.service.origin, "/v1/projects", {
      authorization: suppliedAuthorization
    });

    // Then
    expect(response.status).toBe(status);
  });

  it("hides a foreign owner's Project", async () => {
    // Given
    const fixture = await importedFixture("attachment-foreign");
    const foreign = basic(wrongHostRootReadIssuer.username, wrongHostRootReadIssuer.password);

    // When
    const response = await discovery(fixture.service.origin, "/v1/projects/project-a/attachment", {
      authorization: foreign
    });

    // Then
    expect(response.status).toBe(404);
  });

  it("requires activation and the exact generation header", async () => {
    // Given
    const root = await createFinalizeRoot("attachment-generation");
    const service = await startFinalizeService(root);

    // When
    const inactive = await discovery(service.origin, "/v1/projects");
    await activateFinalizeService(service.origin);
    const stale = await discovery(service.origin, "/v1/projects", { generation: "b".repeat(64) });

    // Then
    expect(inactive.status).toBe(503);
    expect(stale.status).toBe(409);
  });

  it("fails the whole descriptor when any completed repository is unavailable", async () => {
    // Given
    const fixture = await importedFixture("attachment-unavailable");
    const tree = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "rev-parse", "refs/heads/main^{tree}"])).stdout.trim();
    const movedCommit = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit-tree", tree,
      "-m", "unavailable attachment"])).stdout.trim();
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref",
      "refs/heads/main", movedCommit]);

    // When
    const catalog = await discovery(fixture.service.origin, "/v1/projects");
    const response = await discovery(fixture.service.origin, "/v1/projects/project-a/attachment");

    // Then
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ projects: [{ projectId: "project-a", repositoryCount: 1 }] });
    expect(response.status).toBe(409);
  });
});

async function importedFixture(label: string): Promise<{ readonly root: string; readonly service: RunningService }> {
  const root = await createFinalizeRoot(label);
  const service = await startFinalizeService(root);
  await activateFinalizeService(service.origin);
  await importRepository(service, "root");
  return { root, service };
}

async function importRepository(service: RunningService, repositoryId: string) {
  const bundle = await createRootBundle({ [`${repositoryId}.txt`]: `${repositoryId}\n` });
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a", repositoryId));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle, undefined, repositoryId)).json());
  const finalized = await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  }, authorization, repositoryId);
  expect(finalized.status).toBe(200);
  return receipt;
}

function discovery(
  origin: string,
  path: string,
  options: { readonly authorization?: string; readonly generation?: string } = {}
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: {
      authorization: options.authorization ?? rootReadIssuerAuthorization,
      "x-dim-generation-id": options.generation ?? generationId
    }
  });
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
