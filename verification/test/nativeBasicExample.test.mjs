// @ts-check
import { object } from "../scripts/lib/json-values.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";
import { compileNativeRepositoryBootstrapPolicy } from "../../core/packages/managed/src/nativeRootBootstrapPolicy.js";
import { dimWorkflowCompiler } from "../../plugin-ci-workflows/src/index.js";

const root = resolve(import.meta.dirname, "../../examples/projects/native-basic-root");

test("compiles the reviewed example policy and workflow into the same required jobs", async () => {
  const [policySource, runnerSource, ordinaryScript, qemuScript] = await Promise.all([
    readFile(resolve(root, "review-policy.json"), "utf8"),
    readFile(resolve(root, ".dim/ci/runner.yml"), "utf8"),
    readFile(resolve(root, ".dim/ci/jobs/source.bash"), "utf8"),
    readFile(resolve(root, ".dim/ci/jobs/integration.bash"), "utf8")
  ]);
  const manifest = object(JSON.parse(policySource));
  assert.equal(manifest.schemaVersion, 1);
  assert(typeof manifest.repositoryId === "string");
  const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId: manifest.repositoryId,
    protectedRef: "refs/heads/main", review: manifest.review });
  const jobs = dimWorkflowCompiler.compile(Buffer.from(runnerSource));
  assert.deepEqual(policy.reviewPolicy.ciRepositoryIds, [manifest.repositoryId]);
  assert.deepEqual(policy.reviewPolicy.requiredJobs.map(({ name, kind }) => ({ name, kind })),
    jobs.map(({ name, kind }) => ({ name, kind })));
  assert.match(ordinaryScript, /native-basic-ordinary-ok/);
  assert.match(qemuScript, /native-basic-qemu-ok/);
  assert.doesNotMatch(`${policySource}\n${runnerSource}`, /gitea|actions|webhook|runnerToken/i);
});
