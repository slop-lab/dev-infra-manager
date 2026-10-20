import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { afterEach, test } from "vitest";
import { multipleRepositoryExampleFixture } from "../ci/multipleRepositoryExampleFixture.js";
import { closeExampleServices } from "../ci/exampleServiceFixture.js";
import { cleanupFinalizeFixtures, createFinalizeRoot, runGit } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";
import { withNativeGitExecutionReadAuthority } from "../../../packages/host/plugins/ci-worker/src/nativeGitCandidateReadAuthority.js";
import { verifyAndMaterializeCandidate } from "../../../packages/host/plugins/ci-worker/src/candidate.js";
afterEach(async () => { await closeExampleServices(); await cleanupFinalizeFixtures(); });
test("imports the declared basic recipe, plans its actual workflow and executes the pinned container job", async () => {
  const f = await multipleRepositoryExampleFixture(resolve(import.meta.dirname, "../../../examples/projects/native-basic-root"));
  const grant = await f.authorize("root", "source");
  assert.deepEqual(Object.keys(grant.descriptor.inputs), ["root"]);
  const directory = await createFinalizeRoot("basic-example-job"), workspace = join(directory, "workspace"), scriptFile = join(directory, "script");
  const signal = AbortSignal.timeout(20_000), credential = await f.source.candidate(grant);
  await withNativeGitExecutionReadAuthority({ descriptor: grant.descriptor, gitExecutable: "/usr/bin/git",
    serviceEndpoint: f.service.origin, temporaryRoot: directory, credential }, signal,
    (authority) => verifyAndMaterializeCandidate({ descriptor: grant.descriptor, descriptorDigest: grant.descriptorDigest, authority, workspace, scriptFile, signal }));
  const result = await runGit("/bin/bash", ["--noprofile", "--norc", scriptFile], { cwd: join(workspace, "root"), timeout: 10_000 });
  assert.match(result.stdout, /native-basic-ordinary-ok/);
}, 30_000);
test("the declared compiler is required rather than silently supplied by the test harness", async () => {
  const { loadExampleRecipe } = await import("../../../scripts/examples/recipe.ts");
  const { startExampleService } = await import("../ci/exampleServiceFixture.js");
  const recipe = await loadExampleRecipe(resolve(import.meta.dirname, "../../../examples/projects/native-basic-root"));
  await assert.rejects(startExampleService({ ...recipe, plugins: { ...recipe.plugins,
    controlPlane: recipe.plugins.controlPlane.filter((specifier) => !specifier.startsWith("@slop-lab/dim-control-plane-plugin-ci-workflows@"))
  } }, await createFinalizeRoot("basic-missing-compiler")), /workflow compiler/);
});
