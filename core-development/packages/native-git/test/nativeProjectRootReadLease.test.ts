import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  rootReadIssuerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService,
  uploadRootBundle,
  wrongHostRootReadIssuer,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);

afterEach(cleanupFinalizeFixtures);

describe("native Project root read lease", () => {
  it("serves only upload-pack for a fully live imported owned root", async () => {
    // Given
    const fixture = await finalizedFixture("root-read-live");
    const lease = await issueLease(fixture.service.origin);
    const remote = authenticatedRemote(fixture.service.origin, "project-a", lease);
    const clone = await createFinalizeRoot("root-read-clone");

    // When
    const advertised = await run("/usr/bin/git", ["ls-remote", remote]);
    await run("/usr/bin/git", ["clone", remote, clone]);

    // Then
    expect(advertised.stdout).toContain(`${fixture.bundle.commit}\trefs/heads/main`);
    expect(await readFile(join(clone, "README.md"), "utf8")).toBe("root bundle\n");
    await writeFile(join(clone, "change.txt"), "denied\n");
    await run("/usr/bin/git", ["-C", clone, "add", "change.txt"]);
    await run("/usr/bin/git", ["-C", clone, "-c", "user.name=DIM Test", "-c",
      "user.email=dim@example.invalid", "commit", "-m", "denied push"]);
    await expect(run("/usr/bin/git", ["-C", clone, "push", remote,
      "HEAD:refs/heads/proposals/host/change"])).rejects.toThrow();
    expect(await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "for-each-ref", "--format=%(refname)"])).toMatchObject({ stdout: "refs/heads/main\n" });
  });

  it.each([
    ["unknown", basic("unknown", Buffer.alloc(32, 90).toString("base64url")), "project-a", generationId, 401],
    ["registrar role", basic("registrar-a", bundleSecrets.projectRegistrar), "project-a", generationId, 403],
    ["importer role", authorization, "project-a", generationId, 403],
    ["ordinary query role", basic("native-query", bundleSecrets.nativeQuery), "project-a", generationId, 403],
    ["ordinary identity role", basic("ordinary-identity", bundleSecrets.nativeIdentity), "project-a", generationId, 403],
    ["ordinary attempt role", basic("ordinary-attempts", bundleSecrets.attemptIssuer), "project-a", generationId, 403],
    ["ordinary result role", basic("ordinary-results", bundleSecrets.resultReporter), "project-a", generationId, 403],
    ["ordinary webhook role", basic("native-events", bundleSecrets.webhook), "project-a", generationId, 403],
    ["foreign owner host", basic(wrongHostRootReadIssuer.username, wrongHostRootReadIssuer.password),
      "project-a", generationId, 404],
    ["unknown Project", rootReadIssuerAuthorization, "project-missing", generationId, 404],
    ["wrong generation", rootReadIssuerAuthorization, "project-a", "b".repeat(64), 409]
  ] as const)("denies lease issuance for %s", async (_label, credential, projectId, requestedGeneration, status) => {
    // Given
    const fixture = await finalizedFixture("root-read-issuance-denial");

    // When
    const response = await requestLease(fixture.service.origin, projectId, credential, requestedGeneration);

    // Then
    expect(response.status).toBe(status);
  });

  it("denies issuance for an incomplete import", async () => {
    // Given
    const root = await createFinalizeRoot("root-read-incomplete");
    const bundle = await createRootBundle();
    const service = await startFinalizeService(root);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    expect((await uploadRootBundle(service.origin, bundle)).status).toBe(200);

    // When
    const response = await requestLease(service.origin, "project-a", rootReadIssuerAuthorization, generationId);

    // Then
    expect(response.status).not.toBe(200);
  });

  it("denies issuance before exact activation", async () => {
    // Given
    const root = await createFinalizeRoot("root-read-inactive");
    const service = await startFinalizeService(root);

    // When
    const response = await requestLease(service.origin, "project-a", rootReadIssuerAuthorization, generationId);

    // Then
    expect(response.status).toBe(503);
  });

  it("rechecks live root state on every transport request", async () => {
    // Given
    const fixture = await finalizedFixture("root-read-ref-drift");
    const lease = await issueLease(fixture.service.origin);
    const movedCommit = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit-tree",
      fixture.bundle.tree, "-m", "moved root"])).stdout.trim();
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root), "update-ref",
      "refs/heads/main", movedCommit, fixture.bundle.commit]);

    // When
    const response = await uploadPackDiscovery(fixture.service.origin, "project-a", "root", lease);

    // Then
    expect(response.status).not.toBe(200);
  });

  it("rejects an incomplete object graph after lease issuance", async () => {
    // Given
    const fixture = await finalizedFixture("root-read-graph-drift");
    const lease = await issueLease(fixture.service.origin);
    const packDirectory = join(rootRepository(fixture.root), "objects", "pack");
    const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"));
    if (pack === undefined) throw new Error("imported root has no pack fixture");
    await writeFile(join(packDirectory, pack), "corrupt graph", { mode: 0o444 });

    // When
    const response = await uploadPackDiscovery(fixture.service.origin, "project-a", "root", lease);

    // Then
    expect(response.status).toBe(409);
  });

  it("denies expired, restarted, wrong-Project, wrong-repository, issuer, and importer credentials", async () => {
    // Given
    let now = 1_000;
    const fixture = await finalizedFixture("root-read-scope", () => now);
    const lease = await issueLease(fixture.service.origin);

    // When / Then
    expect((await uploadPackDiscovery(fixture.service.origin, "project-b", "root", lease)).status).toBe(404);
    expect((await uploadPackDiscovery(fixture.service.origin, "project-a", "other", lease)).status).toBe(404);
    expect((await uploadPackDiscovery(fixture.service.origin, "project-a", "root", {
      username: "project-root-read-issuer-a", password: bundleSecrets.projectRootReadIssuer
    })).status).not.toBe(200);
    expect((await uploadPackDiscovery(fixture.service.origin, "project-a", "root", {
      username: importer.username, password: importer.password
    })).status).not.toBe(200);

    now = lease.expiresAt;
    expect((await uploadPackDiscovery(fixture.service.origin, "project-a", "root", lease)).status).toBe(401);

    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root, () => 1_000);
    expect((await uploadPackDiscovery(restarted.origin, "project-a", "root", lease)).status).toBe(401);
  });

  it("denies every receive-pack form even with a valid lease", async () => {
    // Given
    const fixture = await finalizedFixture("root-read-receive-denial");
    const lease = await issueLease(fixture.service.origin);

    // When
    const discovery = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic(lease.username, lease.password) }
    });
    const rpc = await fetch(`${fixture.service.origin}/v1/projects/project-a/repositories/root.git/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: basic(lease.username, lease.password),
        "content-type": "application/x-git-receive-pack-request"
      },
      body: Buffer.alloc(0)
    });

    // Then
    expect(discovery.status).toBe(403);
    expect(rpc.status).toBe(403);
  });
});

async function finalizedFixture(label: string, clock?: () => number): Promise<{
  readonly root: string;
  readonly bundle: Awaited<ReturnType<typeof createRootBundle>>;
  readonly service: RunningService;
}> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root, clock);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { root, bundle, service };
}

async function issueLease(origin: string): Promise<RootReadLease> {
  const response = await requestLease(origin, "project-a", rootReadIssuerAuthorization, generationId);
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid lease response");
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  const expiresAt = Reflect.get(value, "expiresAt");
  if (typeof username !== "string" || typeof password !== "string" || typeof expiresAt !== "number") {
    throw new Error("invalid lease response");
  }
  return { username, password, expiresAt };
}

function requestLease(origin: string, projectId: string, credential: string, requestedGeneration: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/${projectId}/root-read-leases`, {
    method: "POST",
    headers: { authorization: credential, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: requestedGeneration })
  });
}

function uploadPackDiscovery(
  origin: string,
  projectId: string,
  repositoryId: string,
  credential: Pick<RootReadLease, "username" | "password">
): Promise<Response> {
  return fetch(`${origin}/v1/projects/${projectId}/repositories/${repositoryId}.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: basic(credential.username, credential.password) }
  });
}

function authenticatedRemote(origin: string, projectId: string, lease: RootReadLease): string {
  const url = new URL(`/v1/projects/${projectId}/repositories/root.git`, origin);
  url.username = lease.username;
  url.password = lease.password;
  return url.toString();
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

type RootReadLease = {
  readonly username: string;
  readonly password: string;
  readonly expiresAt: number;
};
