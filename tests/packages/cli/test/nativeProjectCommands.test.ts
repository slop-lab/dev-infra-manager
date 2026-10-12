import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import {
  cleanupNativeProjectFixtures,
  nativeFixture,
  pendingView,
  rewriteJson,
  runCli,
  type NativeFixture
} from "./nativeProjectCommandsFixture.js";

const runFile = promisify(execFile);
afterEach(cleanupNativeProjectFixtures);

test("native root bootstrap imports an exact reviewed local source before project create converges ready", async () => {
  // Given
  const fixture = await nativeFixture({ seedImportedDraft: false });
  const bootstrapArguments = ["project", "bootstrap-native-root", "acme",
    "--project-id", "project-a", "--source-repository", fixture.sourceRepository,
    "--source-ref", "refs/heads/main", "--registrar-connection", fixture.registrarPath,
    "--importer-connection", fixture.importerPath, "--json"];

  // When
  const imported = await runCli(bootstrapArguments, fixture.environment);
  const replayed = await runCli(bootstrapArguments, fixture.environment);
  const created = await runCli(["project", "create", "acme", "--json"], fixture.environment);

  // Then
  for (const result of [imported, replayed, created]) assert.equal(result.status, 0, result.stderr);
  const importedView = JSON.parse(imported.stdout) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(replayed.stdout), importedView);
  assert.deepEqual(importedView, {
    name: "acme", projectId: "project-a", serviceId: "native-main", ownerHostId: "host-a",
    generationId: fixture.importGenerationId, phase: "root-imported", rootAlias: "root",
    protectedRef: "refs/heads/main", rootCommit: fixture.commit, rootTree: fixture.tree,
    policyRevision: pendingView(fixture.commit, fixture.tree).policyRevision,
    requiredReviewRevision: pendingView(fixture.commit, fixture.tree).requiredReviewRevision,
    requiredJobSetRevision: pendingView(fixture.commit, fixture.tree).requiredJobSetRevision,
    bundleDigest: importedView.bundleDigest, bundleSize: importedView.bundleSize
  });
  assert.match(String(importedView.bundleDigest), /^[0-9a-f]{64}$/);
  assert.equal(typeof importedView.bundleSize, "number");
  assert.deepEqual(JSON.parse(created.stdout), {
    ...pendingView(fixture.commit, fixture.tree),
    phase: "ready",
    runnable: true,
    readyAt: (JSON.parse(created.stdout) as { readonly readyAt: string }).readyAt
  });
  assert.doesNotMatch(`${imported.stdout}${replayed.stdout}${created.stdout}`,
    /password|credential|connection|endpoint|importNonce/i);
  assert.equal(await remoteHead(fixture), fixture.commit);
});

test("native project create converges imported root to ready without CI and restart list/show expose no credentials", async () => {
  // Given
  const fixture = await nativeFixture();

  // When
  const created = await runCli(["project", "create", "acme", "--json"], fixture.environment);
  assert.equal(created.status, 0, created.stderr);
  const projectPath = join(fixture.stateRoot, "projects", "acme.json");
  const beforeReplay = await stat(projectPath, { bigint: true });
  const replay = await runCli(["project", "create", "acme", "--json"], fixture.environment);
  const listed = await runCli(["project", "list", "--json"], fixture.environment);
  const humanList = await runCli(["project", "list"], fixture.environment);
  const shown = await runCli(["project", "show", "acme", "--json"], fixture.environment);
  const afterReplay = await stat(projectPath, { bigint: true });
  const remoteHead = (await runFile("/usr/bin/git", [
    "--git-dir", join(fixture.serviceRoot, "project-a", "root.git"), "rev-parse", "refs/heads/main"
  ])).stdout.trim();

  // Then
  for (const result of [created, replay, listed, humanList, shown]) assert.equal(result.status, 0, result.stderr);
  const expectedPending = pendingView(fixture.commit, fixture.tree);
  const readyAt = (JSON.parse(created.stdout) as { readyAt: string }).readyAt;
  const expected = { ...expectedPending, phase: "ready", runnable: true, readyAt };
  for (const field of ["projectId", "serviceId", "ownerHostId", "rootCommit", "rootTree",
    "policyRevision", "requiredReviewRevision", "requiredJobSetRevision"]) {
    assert.match(humanList.stdout, new RegExp(field));
  }
  assert.match(humanList.stdout, /ready/);
  assert.match(humanList.stdout, /true/);
  assert.deepEqual(JSON.parse(created.stdout), expected);
  assert.deepEqual(JSON.parse(replay.stdout), expected);
  assert.deepEqual(JSON.parse(listed.stdout), [expected]);
  assert.deepEqual(JSON.parse(shown.stdout), expected);
  assert.equal(remoteHead, fixture.commit);
  assert.deepEqual(
    { ino: afterReplay.ino, mtimeNs: afterReplay.mtimeNs, ctimeNs: afterReplay.ctimeNs },
    { ino: beforeReplay.ino, mtimeNs: beforeReplay.mtimeNs, ctimeNs: beforeReplay.ctimeNs }
  );
  assert.doesNotMatch(`${created.stdout}${listed.stdout}${shown.stdout}`, /password|credential|connection|endpoint|importNonce/i);
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), {
    ...(JSON.parse(await readFile(projectPath, "utf8")) as object),
    schemaVersion: 6,
    phase: "ready",
    readyAt
  });
});

test("native project create rejects changed importer authority and changed receipt without state mutation", async (context) => {
  await context.test("changed credential", async () => {
    const fixture = await nativeFixture();
    await rewriteJson(fixture.importerPath, (value) => ({ ...value, credential: {
      ...(value.credential as object), password: Buffer.alloc(32, 99).toString("base64url")
    } }));
    await assertCreateRejectedWithoutProject(fixture);
  });
  await context.test("changed generation", async () => {
    const fixture = await nativeFixture();
    await rewriteJson(fixture.importerPath, (value) => ({ ...value, generationId: "f".repeat(64) }));
    await assertCreateRejectedWithoutProject(fixture);
  });
  await context.test("unsupported HTTPS importer transport", async () => {
    const fixture = await nativeFixture();
    const databasePath = join(fixture.serviceRoot, "native-idle.sqlite3");
    const before = await readFile(databasePath);
    await rewriteJson(fixture.controlPath, (value) => ({ ...value, nativeGit: {
      ...(value.nativeGit as object), transport: "https", endpoint: "https://native.invalid"
    } }));
    const refusal = await runCli(["project", "create", "acme", "--json"], fixture.environment);
    assert.equal(refusal.status, 2, refusal.stderr);
    assert.match(refusal.stderr, /pending admission requires loopback-http/);
    await assert.rejects(stat(join(fixture.stateRoot, "projects")), { code: "ENOENT" });
    assert.deepEqual(await readFile(databasePath), before);
    assert.equal(await remoteHead(fixture), fixture.commit);
  });
  await context.test("changed receipt", async () => {
    const fixture = await nativeFixture();
    const draftPath = join(fixture.stateRoot, "native-project-drafts", "acme.json");
    await rewriteJson(draftPath, (value) => ({ ...value, importReceipt: {
      ...(value.importReceipt as object), importNonce: "10000000-0000-4000-8000-000000000000"
    } }));
    await assertCreateRejectedWithoutProject(fixture);
  });
});

test("native selectors and Gitea collisions fail closed before predecessor dispatch", async () => {
  // Given
  const fixture = await nativeFixture();
  const projectDirectory = join(fixture.stateRoot, "projects");
  await runFile("mkdir", ["-m", "700", projectDirectory]);
  const projectPath = join(projectDirectory, "acme.json");
  const databasePath = join(fixture.serviceRoot, "native-idle.sqlite3");
  const databaseBefore = await readFile(databasePath);
  const remoteBefore = await remoteHead(fixture);
  const collision = `${JSON.stringify({ schemaVersion: 4, id: "project-a", name: "acme",
    gitNamespace: "dim-acme", giteaOrganizationId: 41, phase: "ready", repositories: [],
    createdAt: "now", updatedAt: "now" })}\n`;
  await writeFile(projectPath, collision, { mode: 0o600 });

  // When
  const collided = await runCli(["project", "create", "acme", "--json"], fixture.environment);
  const optionBearing = await runCli([
    "project", "create", "acme", "--repos", join(fixture.stateRoot, "missing.yml")
  ], fixture.environment);
  const empty = await runCli(["project", "list", "--json"], {
    ...fixture.environment, DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: ""
  });
  const emptyImporter = await runCli(["project", "create", "acme", "--json"], {
    ...fixture.environment, DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE: ""
  });
  const repository = await runCli(["repo", "list", "acme"], fixture.environment);
  const ordinaryService = await runCli(["ci", "ordinary-pool", "service", "run",
    join(fixture.stateRoot, "missing-predecessor-service.json")], fixture.environment);

  // Then
  for (const [label, result] of Object.entries({
    collided, optionBearing, empty, emptyImporter, repository, ordinaryService
  })) {
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
  }
  assert.equal(await readFile(projectPath, "utf8"), collision);
  assert.deepEqual(await readFile(databasePath), databaseBefore);
  assert.equal(await remoteHead(fixture), remoteBefore);
  await assert.rejects(stat(join(fixture.stateRoot, "services", "gitea.json")), { code: "ENOENT" });
  assert.match(optionBearing.stderr, /only plain 'dim project create PROJECT'/);
  assert.match(empty.stderr, /native control-plane connection file selector must not be empty/);
  assert.match(emptyImporter.stderr, /DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE is required/);
  assert.match(repository.stderr, /refusing Gitea fallback/);
  assert.match(ordinaryService.stderr, /refusing Gitea fallback/);
});

test("native list rejects a foreign host selector without rewriting pending state", async () => {
  // Given
  const fixture = await nativeFixture();
  assert.equal((await runCli(["project", "create", "acme"], fixture.environment)).status, 0);
  const projectPath = join(fixture.stateRoot, "projects", "acme.json");
  const before = await readFile(projectPath);
  await rewriteJson(fixture.controlPath, (value) => ({
    ...value,
    hostId: "host-b",
    nativeGit: { ...(value.nativeGit as object), workspaceWriteIssuer: {
      ...((value.nativeGit as { workspaceWriteIssuer: object }).workspaceWriteIssuer), username: "host-b"
    } }
  }));

  // When
  const result = await runCli(["project", "list", "--json"], fixture.environment);

  // Then
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /belongs to another native host/);
  assert.deepEqual(await readFile(projectPath), before);
});

test("native project remove and purge refuse predecessor dispatch", async () => {
  // Given
  const fixture = await nativeFixture();
  assert.equal((await runCli(["project", "create", "acme"], fixture.environment)).status, 0);
  const projectPath = join(fixture.stateRoot, "projects", "acme.json");
  const before = await readFile(projectPath);

  // When
  const removed = await runCli(["project", "remove", "acme"], fixture.environment);
  const purged = await runCli(["project", "purge", "acme", "--yes"], fixture.environment);

  // Then
  for (const result of [removed, purged]) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /native Project (remove|purge) is unavailable; refusing Gitea fallback/);
  }
  assert.deepEqual(await readFile(projectPath), before);
  await assert.rejects(stat(join(fixture.stateRoot, "services", "gitea.json")), { code: "ENOENT" });
});

async function assertCreateRejectedWithoutProject(fixture: NativeFixture): Promise<void> {
  const databasePath = join(fixture.serviceRoot, "native-idle.sqlite3");
  const databaseBefore = await readFile(databasePath);
  const remoteBefore = await remoteHead(fixture);
  const result = await runCli(["project", "create", "acme", "--json"], fixture.environment);
  assert.equal(result.status, 2, result.stderr);
  await assert.rejects(stat(join(fixture.stateRoot, "projects")), { code: "ENOENT" });
  assert.deepEqual(await readFile(databasePath), databaseBefore);
  assert.equal(await remoteHead(fixture), remoteBefore);
}

async function remoteHead(fixture: NativeFixture): Promise<string> {
  return (await runFile("/usr/bin/git", ["--git-dir",
    join(fixture.serviceRoot, "project-a", "root.git"), "rev-parse", "refs/heads/main"])).stdout.trim();
}
