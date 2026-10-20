import { gitCiPolicy } from "../../../packages/control-plane/plugins/git-ci/src/policy.js";
import { object } from "../../../scripts/checks/lib/json-values.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";
import { compileNativeRepositoryBootstrapPolicy } from "../../../packages/host/plugins/native-git/src/nativeRootBootstrapPolicy.js";
import { dimWorkflowCompiler } from "../../../packages/control-plane/plugins/ci-workflows/src/index.js";

const root = resolve(import.meta.dirname, "../../../examples/projects/native-basic-root");

test("compiles the reviewed example policy and workflow into the same required jobs", async () => {
  const [policySource, runnerSource, ordinaryScript, qemuScript] = await Promise.all([
    readFile(resolve(root, "repository-policy.json"), "utf8"),
    readFile(resolve(root, ".dim/ci/runner.yml"), "utf8"),
    readFile(resolve(root, ".dim/ci/jobs/source.bash"), "utf8"),
    readFile(resolve(root, ".dim/ci/jobs/integration.bash"), "utf8")
  ]);
  const manifest = object(JSON.parse(policySource));
  assert.equal(manifest.schemaVersion, 1);
  assert(typeof manifest.repositoryId === "string");
  const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId: manifest.repositoryId,
    protectedRef: "refs/heads/main", extensions: manifest.extensions });
  const selected = gitCiPolicy(policy.repositoryPolicy, manifest.repositoryId);
  const jobs = dimWorkflowCompiler.compile(Buffer.from(runnerSource));
  assert.deepEqual(selected.ciRepositoryIds, [manifest.repositoryId]);
  assert.deepEqual(selected.requiredJobs.map(({ name, kind }) => ({ name, kind })),
    jobs.map(({ name, kind }) => ({ name, kind })));
  assert.match(ordinaryScript, /native-basic-ordinary-ok/);
  assert.match(qemuScript, /native-basic-qemu-ok/);
});
