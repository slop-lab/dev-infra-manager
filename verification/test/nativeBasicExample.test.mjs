import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../examples/projects/native-basic-root");

test("defines one protected native root and kind-distinct candidate jobs", async () => {
  // Given
  const [repositoriesSource, runnerSource, ordinaryScript, qemuScript] = await Promise.all([
    readFile(resolve(root, ".dim/repos.yml"), "utf8"),
    readFile(resolve(root, ".dim/ci/runner.yml"), "utf8"),
    readFile(resolve(root, ".dim/ci/jobs/source.bash"), "utf8"),
    readFile(resolve(root, ".dim/ci/jobs/integration.bash"), "utf8")
  ]);

  // When
  const repositories = parse(repositoriesSource);
  const runner = parse(runnerSource);

  // Then
  assert.deepEqual(repositories.nativeReview.requiredJobs, [
    { name: "source", kind: "ordinary-sysbox" },
    { name: "integration", kind: "qemu" }
  ]);
  assert.equal(repositories.repositories.root.root, true);
  assert.deepEqual(repositories.repositories.root.protect, ["main"]);
  assert.deepEqual(runner.jobs, {
    source: { script: ".dim/ci/jobs/source.bash" },
    integration: { script: ".dim/ci/jobs/integration.bash", runtime: "qemu" }
  });
  assert.match(ordinaryScript, /native-basic-ordinary-ok/);
  assert.match(qemuScript, /native-basic-qemu-ok/);
  assert.doesNotMatch(`${repositoriesSource}\n${runnerSource}`, /gitea|actions|webhook|runnerToken/i);
});
