import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildPublishedCli } from "./publishedCliFixture.js";

const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const sourceCli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

test("normal published CLI reports its package metadata version", () => {
  // Given
  const environment = { ...process.env };
  delete environment.DIM_LOCAL_BUILD_VERSION;

  // When
  const fixture = buildPublishedCli(environment);

  // Then
  assert.equal(fixture.metadataVersion, "0.10.0");
  assert.equal(fixture.publishedVersion, "0.10.0");
});

test("local published CLI reports its package metadata version", () => {
  // Given
  const version = "0.10.0-local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-dirty";

  // When
  const sharedArtifacts = ["package.json", "package-version.js"].map((file) => path.join(packageDirectory, "dist", file));
  const before = sharedArtifacts.map((file) => readFileSync(file));
  const fixture = buildPublishedCli({ ...process.env, DIM_LOCAL_BUILD_VERSION: version });
  assert.deepEqual(sharedArtifacts.map((file) => readFileSync(file)), before);

  // Then
  assert.equal(fixture.metadataVersion, version);
  assert.equal(fixture.publishedVersion, version);
});

test("source CLI reports the normal package version deterministically", () => {
  // Given
  const expected = "0.10.0";

  // When
  const result = spawnSync(process.execPath, ["--import", tsxImport, sourceCli, "--version"], {
    cwd: packageDirectory,
    encoding: "utf8"
  });

  // Then
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected);
});
