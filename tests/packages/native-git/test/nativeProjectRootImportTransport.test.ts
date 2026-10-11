import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import {
  configuredNativeGitBundleServer,
  type NativeGitBundleServer
} from "../../../../core/packages/native-git/src/native-bundle-server.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";
import { refValue } from "./nativeGitHarness.js";

const run = promisify(execFile);
const generationId = "a".repeat(64);
const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const roots: string[] = [];
const services: NativeGitBundleServer[] = [];
const policy = {
  schemaVersion: 1,
  protectedRef: "refs/heads/main",
  policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
  requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
  requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
  requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
  requiredReviewerIds: ["owner"],
  pathReviewerRules: []
} as const;

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Project root bundle receipt", () => {
  it("returns and restart-replays an exact durable receipt for a real self-contained bundle", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-http-"));
    roots.push(root);
    const bundle = await createBundle();
    const first = await start(root);
    await activate(first.origin);
    await first.prepareProject(generationId, "host-a", project("project-a"));
    const prelude = importPrelude("project-a", bundle.commit);

    // When
    const firstResponse = await upload(first.origin, "project-a", prelude, bundle.bytes);

    // Then
    expect(firstResponse.status).toBe(200);
    const receipt = await firstResponse.json();
    expect(receipt).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      projectId: "project-a",
      rootRepositoryId: "root",
      generationId,
      importNonce: expect.any(String),
      protectedRef: "refs/heads/main",
      expectedCommit: bundle.commit,
      policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      bundleDigest: createHash("sha256").update(bundle.bytes).digest("hex"),
      bundleSize: bundle.bytes.length,
      phase: "bundle-durable"
    });
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase, bundle_sha256, bundle_size FROM native_project_root_import").get())
      .toEqual({
        phase: "bundle-durable",
        bundle_sha256: receipt.bundleDigest,
        bundle_size: bundle.bytes.length
      });
    database.close();
    expect(await readFile(join(root, "project-a", ".dim-root-import", `${receipt.importNonce}.bundle`)))
      .toEqual(bundle.bytes);
    expect(await refValue(join(root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
    expect((await readdir(join(root, "project-a", "root.git", "refs", "heads"))).length).toBe(0);

    await close(first);
    const restarted = await start(root);
    const replay = await upload(restarted.origin, "project-a", prelude, bundle.bytes);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(await refValue(join(root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
  });

  it.each([
    ["registrar", "project-registrar-a", bundleSecrets.projectRegistrar, 403],
    ["wrong host importer", "project-root-importer-b", Buffer.alloc(32, 56).toString("base64url"), 404],
    ["unknown", "unknown-importer", Buffer.alloc(32, 55).toString("base64url"), 401]
  ] as const)("rejects the %s credential without a ref or writer capability", async (_label, username, password, status) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-denial-"));
    roots.push(root);
    const bundle = await createBundle();
    const service = await start(root);
    await activate(service.origin);
    await service.prepareProject(generationId, "host-a", project("project-a"));

    // When
    const response = await upload(service.origin, "project-a", importPrelude("project-a", bundle.commit), bundle.bytes, {
      username, password
    });

    // Then
    expect(response.status).toBe(status);
    expect(await refValue(join(root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'native_project_writer'").get()).toBeUndefined();
    expect(database.prepare("SELECT count(*) AS count FROM native_project_root_import").get()).toEqual({ count: 0 });
    database.close();
  });

  it("rejects a corrupt bundle before durable state or canonical ref mutation", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-corrupt-"));
    roots.push(root);
    const bundle = await createBundle();
    const service = await start(root);
    await activate(service.origin);
    await service.prepareProject(generationId, "host-a", project("project-a"));

    // When
    const response = await upload(service.origin, "project-a", importPrelude("project-a", bundle.commit),
      bundle.bytes.subarray(0, bundle.bytes.length - 8));

    // Then
    expect(response.status).toBe(400);
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase, bundle_sha256, bundle_size FROM native_project_root_import").get())
      .toEqual({ phase: "intent", bundle_sha256: null, bundle_size: null });
    database.close();
    expect(await readdir(join(root, "project-a", ".dim-root-import"))).toEqual([]);
    expect(await refValue(join(root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
  });

  it("rejects a bundle advertising multiple refs before durable state", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-multiple-"));
    roots.push(root);
    const bundle = await createBundle(true);
    const service = await start(root);
    await activate(service.origin);
    await service.prepareProject(generationId, "host-a", project("project-a"));

    // When
    const response = await upload(service.origin, "project-a", importPrelude("project-a", bundle.commit), bundle.bytes);

    // Then
    expect(response.status).toBe(400);
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT phase FROM native_project_root_import").get()).toEqual({ phase: "intent" });
    database.close();
    expect(await refValue(join(root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
  });

  it("rejects a mismatched object format before claiming an import intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-format-"));
    roots.push(root);
    const bundle = await createBundle();
    const service = await start(root);
    await activate(service.origin);
    await service.prepareProject(generationId, "host-a", project("project-a"));
    const databasePath = join(root, "native-idle.sqlite3");
    const before = await readFile(databasePath);

    const response = await upload(service.origin, "project-a", {
      ...importPrelude("project-a", bundle.commit), expectedCommit: "c".repeat(64)
    }, bundle.bytes);

    expect(response.status).toBe(400);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT count(*) AS count FROM native_project_root_import").get()).toEqual({ count: 0 });
    database.close();
    expect(await readFile(databasePath)).toEqual(before);
    expect(await refValue(join(root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
  });
});

async function start(root: string): Promise<RunningService> {
  const config = {
    ...idleNativeConfig(),
    projectRegistrars: [{
      hostId: "host-a", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
    }],
    projectRootImporters: [
      { hostId: "host-a", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter },
      { hostId: "host-b", username: "project-root-importer-b", password: Buffer.alloc(32, 56).toString("base64url") }
    ],
    humanReviewers: [{ reviewerId: "owner", username: "human-reviewer-owner", password: bundleSecrets.humanReviewer }]
  };
  const service = await configuredNativeGitBundleServer({
    config: parseNativeGitBundleConfig(config), stateDirectory: root, readinessToken, activationToken,
    expectedGenerationId: generationId
  });
  services.push(service);
  return { ...service, origin: await service.listen("127.0.0.1", 0) };
}

async function close(service: NativeGitBundleServer): Promise<void> {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

async function activate(origin: string): Promise<void> {
  const response = await fetch(`${origin}/v1/activation`, {
    method: "POST",
    headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
  expect(response.status).toBe(200);
}

async function upload(
  origin: string,
  projectId: string,
  prelude: ReturnType<typeof importPrelude>,
  bundle: Buffer,
  credential = { username: "project-root-importer-a", password: bundleSecrets.projectRootImporter }
): Promise<Response> {
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(prelude)}\n`), bundle]);
  return fetch(`${origin}/v1/projects/${projectId}/root-import`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      "content-type": "application/octet-stream",
      "content-length": String(body.length)
    },
    body
  });
}

async function createBundle(multipleRefs = false): Promise<{ readonly bytes: Buffer; readonly commit: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-import-bundle-"));
  roots.push(root);
  const source = join(root, "source");
  const bundlePath = join(root, "root.bundle");
  await run("/usr/bin/git", ["init", "--initial-branch=main", source]);
  await writeFile(join(source, "README.md"), "root bundle\n");
  await run("/usr/bin/git", ["-C", source, "add", "README.md"]);
  await run("/usr/bin/git", ["-C", source, "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid", "commit", "-m", "root"]);
  const { stdout } = await run("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"]);
  if (multipleRefs) await run("/usr/bin/git", ["-C", source, "branch", "other"]);
  await run("/usr/bin/git", ["-C", source, "bundle", "create", bundlePath,
    ...(multipleRefs ? ["--all"] : ["refs/heads/main"])]);
  return { bytes: await readFile(bundlePath), commit: stdout.trim() };
}

function project(projectId: string) {
  return { serviceId: "native-main", projectId, rootRepositoryId: "root" } as const;
}

function importPrelude(projectId: string, expectedCommit: string) {
  return {
    schemaVersion: 1,
    generationId,
    serviceId: "native-main",
    projectId,
    rootRepositoryId: "root",
    protectedRef: "refs/heads/main",
    expectedCommit,
    policy
  } as const;
}

type RunningService = NativeGitBundleServer & { readonly origin: string };
