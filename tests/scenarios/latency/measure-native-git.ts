import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const tree = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../", import.meta.url)));
const mode = process.argv[3] ?? "proof";
if (mode !== "proof" && mode !== "git") throw new Error("usage: measure-native-git.ts [SOURCE_TREE] [proof|git]");
const fixture: typeof import("../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js") =
  await import(pathToFileURL(resolve(tree, "tests/control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.ts")).href);

function timing(samples: readonly number[]) {
  const warm = samples.slice(1).sort((left, right) => left - right);
  return { coldMilliseconds: samples[0], warmSamples: warm.length, p50Milliseconds: warm[Math.ceil(warm.length * 0.5) - 1],
    p95Milliseconds: warm[Math.ceil(warm.length * 0.95) - 1], samplesMilliseconds: samples };
}

try {
  if (mode === "proof") {
    const root = await fixture.createFinalizeRoot("latency-proof-driver");
    const bundle = await fixture.createRootBundle();
    const service = await fixture.startFinalizeService(root);
    await fixture.activateFinalizeService(service.origin);
    await service.prepareProject(fixture.generationId, fixture.importer.hostId, fixture.projectInput("project-a"));
    const receipt = fixture.parseImportReceipt(await (await fixture.uploadRootBundle(service.origin, bundle)).json());
    const finalized = await fixture.finalizeRootImport(service.origin, { schemaVersion: 1, generationId: fixture.generationId,
      importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest });
    assert.equal(finalized.status, 200);
    const samples: number[] = [];
    for (let index = 0; index < 11; index++) {
      const started = performance.now();
      const response = await fetch(`${service.origin}/v1/projects/project-a/repositories/root/import/proof`, {
        method: "POST", headers: { authorization: fixture.authorization, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, generationId: fixture.generationId })
      });
      assert.equal(response.status, 200); await response.arrayBuffer();
      samples.push(performance.now() - started);
    }
    console.log(JSON.stringify({ tree, mode, node: process.version, proof: timing(samples) }));
  } else {
    const reviewFixture: typeof import("../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js") =
      await import(pathToFileURL(resolve(tree, "tests/control-plane/plugins/git-ci/nativeBundleReviewFixture.ts")).href);
    const reviewApi: typeof import("../../../packages/control-plane/plugins/git-review/src/plugin-api.js") =
      await import(pathToFileURL(resolve(tree, "packages/control-plane/plugins/git-review/src/plugin-api.ts")).href);
    const active = await reviewFixture.nativeBundleReviewFixture("latency-git-driver");
    const preparation = reviewApi.reviewPreparations(active.service.context.extensions).find(({ name }) => name === "git-ci");
    assert.ok(preparation);
    const original = preparation.prepare;
    Object.defineProperty(preparation, "prepare", { value: async (input: Parameters<typeof original>[0]) => {
      await delay(1_000); return original(input);
    } });
    const push: number[] = [], ordinary: number[] = [], discovery: number[] = [];
    try {
      for (let index = 0; index < 6; index++) {
        await reviewFixture.addCandidateCommit(active.clone, `latency-${index}.txt`, Buffer.from(`candidate ${index}\n`));
        const started = performance.now();
        await fixture.runGit("/usr/bin/git", ["-C", active.clone, "push", "origin", `HEAD:${reviewFixture.reviewProposalRef}`]);
        push.push(performance.now() - started);
        const candidate = (await fixture.runGit("/usr/bin/git", ["-C", active.clone, "rev-parse", "HEAD"])).stdout.trim();
        const endpoint = `${active.service.origin}/v1/projects/project-a/repositories/root/review-preparations`;
        const deadline = performance.now() + 15_000;
        for (;;) {
          const response = await fetch(endpoint, { headers: { authorization: fixture.humanReviewerAuthorization,
            "x-dim-generation-id": fixture.generationId } });
          if (response.status === 404) break;
          assert.equal(response.status, 200);
          const body: unknown = await response.json();
          assert.ok(typeof body === "object" && body !== null && "jobs" in body && Array.isArray(body.jobs));
          if (body.jobs.some((job: unknown) => typeof job === "object" && job !== null
            && Reflect.get(job, "candidateCommit") === candidate && Reflect.get(job, "status") === "ready")) break;
          assert.ok(performance.now() < deadline, "asynchronous preparation did not complete"); await delay(20);
        }
        const ordinaryStarted = performance.now();
        await fixture.runGit("/usr/bin/git", ["-C", active.clone, "push", "origin", `HEAD:refs/heads/latency-${index}`]);
        ordinary.push(performance.now() - ordinaryStarted);
        const discoveryStarted = performance.now();
        await fixture.runGit("/usr/bin/git", ["-C", active.clone, "ls-remote", "origin", "HEAD"]);
        discovery.push(performance.now() - discoveryStarted);
      }
    } finally { Object.defineProperty(preparation, "prepare", { value: original }); }
    console.log(JSON.stringify({ tree, mode, node: process.version, downstreamPreparationDelayMilliseconds: 1_000,
      proposalPush: timing(push), ordinaryPush: timing(ordinary), discovery: timing(discovery) }));
  }
} finally { await fixture.cleanupFinalizeFixtures(); }
