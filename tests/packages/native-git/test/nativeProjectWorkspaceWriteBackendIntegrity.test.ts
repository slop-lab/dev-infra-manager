import { appendFile, chmod, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
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
  workspaceWriteIssuerAuthorization,
  type RunningService,
  type RuntimeGit
} from "./nativeRootImportFinalizeFixture.js";

const workspaceId = Buffer.alloc(32, 60).toString("base64url");

afterEach(cleanupFinalizeFixtures);

describe("native Project workspace write backend integrity", () => {
  it("rejects transport after the proposal-only hook changes", async () => {
    // Given
    const fixture = await finalizedFixture("workspace-write-hook-integrity");
    const lease = await issueLease(fixture.service.origin);
    await writeFile(join(rootRepository(fixture.root), "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700
    });

    // When
    const response = await uploadPackDiscovery(fixture.service.origin, lease);

    // Then
    expect(response.status).not.toBe(200);
  });

  it("rejects transport after the pinned Git executable identity changes", async () => {
    // Given
    const root = await createFinalizeRoot("workspace-write-git-integrity");
    const binaryRoot = await createFinalizeRoot("workspace-write-git-binary");
    const executable = join(binaryRoot, "git");
    await copyFile("/usr/bin/git", executable);
    await chmod(executable, 0o700);
    const versionOutput = (await runGit(executable, ["--version"])).stdout.trim();
    const runtimeGit = { gitExecutable: executable, gitVersion: versionOutput.slice("git version ".length) };
    const fixture = await finalizedFixtureAtRoot(root, runtimeGit);
    const lease = await issueLease(fixture.service.origin);
    await appendFile(executable, Buffer.from([0]));

    // When
    const response = await uploadPackDiscovery(fixture.service.origin, lease);

    // Then
    expect(response.status).not.toBe(200);
  });
});

async function finalizedFixture(
  label: string
): Promise<{ readonly root: string; readonly service: RunningService }> {
  const root = await createFinalizeRoot(label);
  return finalizedFixtureAtRoot(root);
}

async function finalizedFixtureAtRoot(
  root: string,
  runtimeGit?: RuntimeGit
): Promise<{ readonly root: string; readonly service: RunningService }> {
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root, undefined, undefined, undefined, undefined, runtimeGit);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { root, service };
}

async function issueLease(origin: string): Promise<WorkspaceWriteLease> {
  const response = await fetch(`${origin}/v1/projects/project-a/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
  });
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TestSetupError();
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  if (typeof username !== "string" || typeof password !== "string") throw new TestSetupError();
  return { username, password };
}

function uploadPackDiscovery(origin: string, lease: WorkspaceWriteLease): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: basic(lease.username, lease.password) }
  });
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

type WorkspaceWriteLease = { readonly username: string; readonly password: string };

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
