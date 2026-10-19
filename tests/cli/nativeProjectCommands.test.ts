import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanupNativeProjectFixtures, nativeFixture, rewriteJson, runCli } from "./nativeProjectCommandsFixture.js";

afterEach(cleanupNativeProjectFixtures);

test("Project CLI independently imports repositories and selects configuration and working defaults", async () => {
  const f = await nativeFixture({ seedImportedDraft: false });
  const policy = join(f.stateRoot, "policy.json");
  const importRepository = async (repositoryId: string) => {
    await writeFile(policy, JSON.stringify({ schemaVersion: 1, repositoryId,
      review: { requiredReviewerIds: ["owner"], requiredJobs: [], ciRepositoryIds: [repositoryId] } }), { mode: 0o600 });
    return runCli(["project", "repository", "import", "acme", repositoryId, "--source", f.sourceRepository,
      "--ref", "refs/heads/main", "--review-policy", policy, "--registrar-connection", f.registrarPath,
      "--importer-connection", f.importerPath, "--json"], f.environment);
  };
  const created = await runCli(["project", "create", "acme", "--project-id", "project-a", "--json"], f.environment);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).phase, "configuring");
  for (const repositoryId of ["public", "private"]) {
    const result = await importRepository(repositoryId);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).repositoryId, repositoryId);
    assert.equal(JSON.parse(result.stdout).commit, f.commit);
  }
  const replay = await importRepository("public"); assert.equal(replay.status, 0, replay.stderr);
  const configured = await runCli(["project", "configure", "acme", "--configuration-repository", "private",
    "--default-repository", "public", "--json"], f.environment);
  assert.equal(configured.status, 0, configured.stderr);
  const project = JSON.parse(configured.stdout);
  assert.equal(project.phase, "ready"); assert.equal(project.runnable, true);
  assert.equal(project.configurationRepositoryId, "private"); assert.equal(project.defaultWorkingRepositoryId, "public");
  assert.deepEqual(Object.keys(project.repositories).sort(), ["private", "public"]);
  const listed = await runCli(["project", "repository", "ls", "acme", "--json"], f.environment);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map((repo: {repositoryId:string}) => repo.repositoryId).sort(), ["private", "public"]);
  const shown = await runCli(["project", "show", "acme", "--json"], f.environment);
  assert.equal(shown.status, 0, shown.stderr); assert.deepEqual(JSON.parse(shown.stdout), project);
  assert.doesNotMatch(configured.stdout + shown.stdout, /password|credential|endpoint/i);
});

test("configuration rejects an unregistered repository without rewriting the Project", async () => {
  const f = await nativeFixture();
  const file = join(f.stateRoot, "projects", "acme.json"), before = await readFile(file);
  const result = await runCli(["project", "configure", "acme", "--configuration-repository", "root",
    "--default-repository", "missing", "--json"], f.environment);
  assert.notEqual(result.status, 0); assert.deepEqual(await readFile(file), before);
  const configured = await runCli(["project", "configure", "acme", "--configuration-repository", "root",
    "--default-repository", "root", "--json"], f.environment);
  assert.equal(configured.status, 0, configured.stderr);
  await f.restartNativeGit();
  const shown = await runCli(["project", "show", "acme", "--json"], f.environment);
  assert.equal(shown.status, 0, shown.stderr); assert.deepEqual(JSON.parse(shown.stdout), JSON.parse(configured.stdout));
});

test("Project catalog rejects a foreign host and incompatible state without adoption", async () => {
  const f = await nativeFixture();
  const file = join(f.stateRoot, "projects", "acme.json"), before = await readFile(file);
  await rewriteJson(f.controlPath, (value) => ({ ...value, hostId: "host-b" }));
  const foreign = await runCli(["project", "list", "--json"], f.environment);
  assert.notEqual(foreign.status, 0); assert.deepEqual(await readFile(file), before);
  await rewriteJson(f.controlPath, (value) => ({ ...value, hostId: "host-a" }));
  const incompatible = JSON.stringify({ schemaVersion: 6, phase: "ready", name: "acme" });
  await writeFile(file, incompatible, { mode: 0o600 });
  const collision = await runCli(["project", "create", "acme", "--project-id", "project-a", "--json"], f.environment);
  assert.notEqual(collision.status, 0); assert.equal(await readFile(file, "utf8"), incompatible);
});
