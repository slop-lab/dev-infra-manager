import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, link, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import {
  cleanupNativeProjectFixtures,
  nativeFixture,
  runCli,
  type NativeFixture
} from "./nativeProjectCommandsFixture.js";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const runFile = promisify(execFile);
afterEach(cleanupNativeProjectFixtures);

test("native root bootstrap help requires explicit local source and separate operator connections", () => {
  const help = spawnSync(process.execPath, ["--import", tsxImport, cli,
    "project", "bootstrap-native-root", "--help"], { cwd: packageDirectory, encoding: "utf8" });

  assert.equal(help.status, 0);
  for (const option of ["--project-id <project-id>", "--source-repository <absolute-path>",
    "--source-ref <full-branch-ref>", "--registrar-connection <absolute-path>",
    "--importer-connection <absolute-path>", "--git-executable <absolute-path>",
    "--review-policy <absolute-private-file>"]) {
    assert.match(help.stdout, new RegExp(option.replace(/[<>]/g, "\\$&")));
  }
  assert.doesNotMatch(help.stdout, /bootstrap-git-url|password|token/);
});

test("native root bootstrap imports a manifest-free source from an explicit reviewed policy", async () => {
  // Given
  const fixture = await nativeFixture({ seedImportedDraft: false });
  await removeReviewedManifest(fixture);
  const reviewPolicy = join(fixture.stateRoot, "review-policy.json");
  await writeFile(reviewPolicy, JSON.stringify({ schemaVersion: 1, rootAlias: "application",
    review: { requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: [] } }), { mode: 0o600 });

  // When
  const imported = await runBootstrap(fixture, reviewPolicy);

  // Then
  assert.equal(imported.status, 0, imported.stderr);
  assert.deepEqual(JSON.parse(imported.stdout), {
    ...(JSON.parse(imported.stdout) as object), rootAlias: "application", protectedRef: "refs/heads/main"
  });
});

test("native root bootstrap does not infer an empty policy when the reviewed manifest is missing", async () => {
  // Given
  const fixture = await nativeFixture({ seedImportedDraft: false });
  await removeReviewedManifest(fixture);

  // When
  const result = await runCli(["project", "bootstrap-native-root", "acme",
    "--project-id", "project-a", "--source-repository", fixture.sourceRepository,
    "--source-ref", "refs/heads/main", "--registrar-connection", fixture.registrarPath,
    "--importer-connection", fixture.importerPath, "--json"], fixture.environment);

  // Then
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /manifest must be a regular reviewed Git blob/);
});

test("native root bootstrap rejects unsafe external policy files before service mutation", async (context) => {
  const valid = JSON.stringify({ schemaVersion: 1, rootAlias: "root",
    review: { requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: [] } });
  const cases: readonly { readonly name: string;
    readonly prepare: (fixture: NativeFixture) => Promise<string> }[] = [
    { name: "relative path", prepare: async () => "review-policy.json" },
    { name: "unknown JSON field", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "unknown.json");
      await writeFile(policyPath, JSON.stringify({ ...JSON.parse(valid), extra: true }), { mode: 0o600 });
      return policyPath;
    } },
    { name: "duplicate top-level key", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "duplicate-top-level.json");
      await writeFile(policyPath, `{"schemaVersion":1,"rootAlias":"ignored","rootAlias":"root","review":${JSON.stringify({
        requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: []
      })}}`, { mode: 0o600 });
      return policyPath;
    } },
    { name: "duplicate nested review key", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "duplicate-review.json");
      await writeFile(policyPath, `{"schemaVersion":1,"rootAlias":"root","review":{"requiredReviewerIds":[],"requiredReviewerIds":["owner"],"pathReviewerRules":[],"requiredJobs":[]}}`,
        { mode: 0o600 });
      return policyPath;
    } },
    { name: "duplicate key inside an array object", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "duplicate-array-object.json");
      await writeFile(policyPath, `{"schemaVersion":1,"rootAlias":"root","review":{"requiredReviewerIds":["owner"],"pathReviewerRules":[{"pathPrefix":"ignored","pathPrefix":"src/","reviewerIds":["owner"]}],"requiredJobs":[]}}`,
        { mode: 0o600 });
      return policyPath;
    } },
    { name: "invalid review", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "invalid-review.json");
      await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, rootAlias: "root",
        review: { requiredReviewerIds: [], pathReviewerRules: [], requiredJobs: [] } }), { mode: 0o600 });
      return policyPath;
    } },
    { name: "symbolic link", prepare: async (fixture) => {
      const target = join(fixture.stateRoot, "symlink-target.json");
      const policyPath = join(fixture.stateRoot, "symlink.json");
      await writeFile(target, valid, { mode: 0o600 });
      await symlink(target, policyPath);
      return policyPath;
    } },
    { name: "oversized file", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "oversized.json");
      await writeFile(policyPath, " ".repeat(64 * 1024 + 1), { mode: 0o600 });
      return policyPath;
    } },
    { name: "group-writable file", prepare: async (fixture) => {
      const policyPath = join(fixture.stateRoot, "writable.json");
      await writeFile(policyPath, valid, { mode: 0o600 });
      await chmod(policyPath, 0o620);
      return policyPath;
    } },
    { name: "multiply linked file", prepare: async (fixture) => {
      const target = join(fixture.stateRoot, "link-target.json");
      const policyPath = join(fixture.stateRoot, "hardlink.json");
      await writeFile(target, valid, { mode: 0o600 });
      await link(target, policyPath);
      return policyPath;
    } }
  ];

  for (const testCase of cases) await context.test(testCase.name, async () => {
    // Given
    const fixture = await nativeFixture({ seedImportedDraft: false });
    const policyPath = await testCase.prepare(fixture);
    const databasePath = join(fixture.serviceRoot, "native-idle.sqlite3");
    const databaseBefore = await readFile(databasePath);

    // When
    const result = await runBootstrap(fixture, policyPath);

    // Then
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(await readFile(databasePath), databaseBefore);
    await assert.rejects(stat(join(fixture.stateRoot, "native-project-drafts")), { code: "ENOENT" });
  });
});

test("native root bootstrap rejects an in-place policy rewrite before service mutation", async () => {
  // Given
  const fixture = await nativeFixture({ seedImportedDraft: false });
  const policyPath = join(fixture.stateRoot, "changing-policy.json");
  const policy = JSON.stringify({ schemaVersion: 1, rootAlias: "root",
    review: { requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: [] } });
  await writeFile(policyPath, policy.padEnd(60 * 1024, " "), { mode: 0o600 });
  const databasePath = join(fixture.serviceRoot, "native-idle.sqlite3");
  const databaseBefore = await readFile(databasePath);
  const writer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], "r+");
    let alternate = false;
    process.stdout.write("ready\\n");
    while (true) {
      fs.writeSync(fd, alternate ? " " : "\\t", ${policy.length}, "utf8");
      alternate = !alternate;
    }
  `, policyPath], { stdio: ["ignore", "pipe", "inherit"] });
  await once(writer.stdout, "data");

  // When
  const result = await runBootstrap(fixture, policyPath).finally(async () => {
    writer.kill("SIGKILL");
    if (writer.exitCode === null) await once(writer, "exit");
  });

  // Then
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(await readFile(databasePath), databaseBefore);
  await assert.rejects(stat(join(fixture.stateRoot, "native-project-drafts")), { code: "ENOENT" });
});

function runBootstrap(fixture: NativeFixture, reviewPolicy: string) {
  return runCli(["project", "bootstrap-native-root", "acme",
    "--project-id", "project-a", "--source-repository", fixture.sourceRepository,
    "--source-ref", "refs/heads/main", "--registrar-connection", fixture.registrarPath,
    "--importer-connection", fixture.importerPath, "--review-policy", reviewPolicy, "--json"],
  fixture.environment);
}

async function removeReviewedManifest(fixture: NativeFixture): Promise<void> {
  await runFile("/usr/bin/git", ["-C", fixture.sourceRepository, "rm", ".dim/repos.yml"]);
  await runFile("/usr/bin/git", ["-C", fixture.sourceRepository, "-c", "user.name=DIM Test", "-c",
    "user.email=dim@example.invalid", "commit", "-m", "remove manifest"]);
}
