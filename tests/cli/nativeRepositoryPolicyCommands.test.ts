import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { cleanupNativeProjectFixtures, nativeFixture, runCli } from "./nativeProjectCommandsFixture.js";

afterEach(cleanupNativeProjectFixtures);
const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../packages/cli/core/src/cli.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
const manifest = (reviewer = "owner") => `schemaVersion: 1
repositories:
  root: {ref: main, protect: [main]}
policy:
  code-review:
    requiredReviewerIds: []
    pathReviewerRules: [{pathPrefix: .dim/, reviewerIds: [${reviewer}]}]
  merge-policy: {}
`;

test("existing repository policy supports default working-tree YAML, preview, replay and JSON without reimporting data", async () => {
  const fixture = await nativeFixture();
  const args = ["project", "repository", "policy"];
  const beforeResult = await runCli([...args, "show", "acme", "root", "--json"], fixture.environment);
  assert.equal(beforeResult.status, 0, beforeResult.stderr);
  const before = JSON.parse(beforeResult.stdout);
  const projectBefore = JSON.parse((await runCli(["project", "show", "acme", "--json"], fixture.environment)).stdout);
  await mkdir(join(fixture.sourceRepository, ".dim"), { recursive: true });
  const file = join(fixture.sourceRepository, ".dim/repos.yml");
  await writeFile(file, manifest(), { mode: 0o600 });
  await chmod(file, 0o600);
  // There is no Git commit: this is an explicitly reviewed host working file.
  const preview = await runCli([...args, "update", "acme", "root", "--file", file, "--preview", "--json"], fixture.environment);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).outcome, "preview");
  assert.equal(JSON.parse((await runCli([...args, "show", "acme", "root", "--json"], fixture.environment)).stdout).policyDigest, before.policyDigest);
  const applied = await execute(process.execPath, ["--conditions=dim-source", "--import", loader, cli, ...args, "update", "acme", "root", "--json"],
    { cwd: fixture.sourceRepository, env: fixture.environment });
  const next = JSON.parse(applied.stdout);
  assert.equal(next.outcome, "updated");
  assert.equal(next.currentHead.commit, before.currentHead.commit);
  assert.notEqual(next.policyDigest, before.policyDigest);
  const replay = await runCli([...args, "update", "acme", "root", "--file", file, "--json"], fixture.environment);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).outcome, "unchanged");
  const jsonFile = join(fixture.sourceRepository, "reviewed-policy.json");
  await writeFile(jsonFile, JSON.stringify({ schemaVersion: 1, repositoryId: "root", extensions: before.policy.extensions }), { mode: 0o600 });
  const restored = await runCli([...args, "update", "acme", "root", "--policy", jsonFile, "--json"], fixture.environment);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).policyDigest, before.policyDigest);
  const projectAfter = JSON.parse((await runCli(["project", "show", "acme", "--json"], fixture.environment)).stdout);
  assert.deepEqual(projectAfter.repositories.root.importReceipt, projectBefore.repositories.root.importReceipt);
  assert.equal(projectAfter.repositories.root.commit, projectBefore.repositories.root.commit);
  assert.equal(await readFile(file, "utf8"), manifest());
});

test("policy update rejects mismatched repository/ref, unsafe files and disabled extensions before changing effective policy", async () => {
  const fixture = await nativeFixture();
  const args = ["project", "repository", "policy", "update", "acme", "root"];
  const file = join(fixture.sourceRepository, "other.yml");
  for (const source of [manifest().replace("root:", "other:"), manifest().replace("ref: main", "ref: other"),
    manifest()+"  unknown-feature: {}\n"]) {
    await writeFile(file, source, { mode: 0o600 });
    const rejected = await runCli([...args, "--file", file, "--json"], fixture.environment);
    assert.equal(rejected.status, 2, rejected.stdout);
  }
  await writeFile(file, manifest()); await chmod(file, 0o666);
  const unsafe = await runCli([...args, "--file", file, "--json"], fixture.environment);
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /non-group\/world-writable/);
});
