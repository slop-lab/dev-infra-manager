import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../../core/packages/managed/src/ci/service.js";
import { executionWorkerClient } from "../../../../../core/packages/managed/src/ci/client.js";
import { nativeGitExecutionSource, StaleExecutionSourceError } from "../../../../../core/packages/managed/src/ci/source.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../../core/packages/managed/src/nativeGitAdmissionHttpClient.js";
import { executionServiceConfigSchema } from "../../../../../core/packages/managed/src/ci/config.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes, reviewProposalRef } from "../../../native-git/test/nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../../../native-git/test/authoritativeNativeCandidateFixture.js";
import { idleOrdinaryConfig, bundleSecrets } from "../../../native-git/test/bundleConfigFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewerAuthorization, hostPromoterAuthorization,
  rootRepository, runGit } from "../../../native-git/test/nativeRootImportFinalizeFixture.js";
import { result } from "./executionFixture.js";

afterEach(cleanupFinalizeFixtures);
it("runs grant, candidate lease and durable result through installed services; promotion uses local Git evidence", async () => {
  let ciOrigin: string | undefined;
  const node = createNodeNativeGitAdmissionHttpClient();
  const native = await nativeBundleReviewFixture("unified-execution", undefined,
    authoritativePolicy(["owner"], [], [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }]),
    undefined, { async request(input) {
      if (ciOrigin === undefined) return { statusCode: 503, contentType: "application/json", cacheControl: "no-store", body: Buffer.from("{}") };
      return node.request({ ...input, endpoint: ciOrigin });
    } }, undefined, undefined, {}, undefined, "jobs:\n  source:\n    script: .dim/ci/jobs/source.bash\n");
  const directory = await mkdtemp(join(tmpdir(), "dim-installed-execution-"));
  const config = executionServiceConfigSchema.parse(idleOrdinaryConfig());
  const source = nativeGitExecutionSource(config.nativeGit, generationId, { request: (input) => node.request({ ...input, endpoint: native.service.origin }) });
  let publicationUnavailable = true;
  const ci = configuredExecutionServer({ config, stateDirectory: directory, readinessToken: "ready", activationToken: "activate",
    expectedGenerationId: generationId, source: { ...source, async publish(grant, result) {
      if (publicationUnavailable) throw new Error("simulated Git outage after execution completion");
      await source.publish(grant, result);
    } } });
  try {
    await new Promise<void>((resolve) => ci.server.listen(0, "127.0.0.1", resolve));
    const address = ci.server.address(); if (address === null || typeof address === "string") throw new Error("no listener");
    ciOrigin = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${ciOrigin}/v1/activation`, { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId }) })).status).toBe(200);
    // NativeGit's durable event dispatcher queues this automatically, without Project CI admission.
    await waitFor(() => ci.store.list().length === 1);
    const worker = executionWorkerClient({ endpoint: ciOrigin, workerId: "host-a", slotId: "primary", token: bundleSecrets.host, generationId });
    const request = randomUUID();
    const [claim, replay] = await Promise.all([worker.claim(request), worker.claim(request)]);
    expect(replay).toEqual(claim);
    expect(claim?.grant?.event.jobName).toBe("source");
    expect(await worker.claim(request)).toEqual(claim);
    if (claim?.grant === undefined) throw new Error("grant missing");
    const credential = await worker.candidate(claim);
    const remote = new URL("/v1/projects/project-a/repositories/root.git", native.service.origin);
    remote.username = credential.username; remote.password = credential.password;
    expect((await runGit("/usr/bin/git", ["ls-remote", remote.toString(), "refs/heads/main"])).stdout).toContain(claim.grant.descriptor.expectedProtectedHead);
    const diagnostic = Buffer.alloc(64 * 1024, "x");
    const output = { bytes: String(8 * 1024 * 1024), sha256: `sha256:${"a".repeat(64)}`, truncated: false };
    const evidence = { ...result(claim.grant), stdout: output, stderr: output,
      logs: { stdout: { base64: diagnostic.toString("base64"), truncated: true },
        stderr: { base64: diagnostic.toString("base64"), truncated: true } } };

    await worker.report(claim, evidence);
    await worker.report(claim, evidence);
    expect(ci.store.get(claim.id).phase).toBe("finished");
    expect((await worker.claim(request))?.result?.logs.stdout.base64).toBe(diagnostic.toString("base64"));
    const query = config.credentials.query;
    const jobs = await fetch(`${ciOrigin}/v1/jobs`, { headers: {
      authorization: `Basic ${Buffer.from(`${query.username}:${query.password}`).toString("base64")}` } });
    expect(JSON.stringify(await jobs.json())).toContain(diagnostic.toString("base64"));
    expect(ci.store.pendingResults()).toHaveLength(1);
    const envelope = (await publishedReviewEnvelopes(native.root))[0]!;
    expect((await post("/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
      { schemaVersion: 1, proposalRef: reviewProposalRef })).status).toBe(200);
    expect((await post(`/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}/approvals`, humanReviewerAuthorization,
      { requestId: randomUUID() })).status).toBe(201);
    const promotionPath = `/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}/promotions`;
    expect((await post(promotionPath, hostPromoterAuthorization, { schemaVersion: 1 })).status).toBe(409);
    publicationUnavailable = false;
    await waitFor(() => ci.store.get(claim.id).publication === "accepted");
    const stored = JSON.parse(await readFile(join(rootRepository(native.root), "dim-execution-evidence", `${claim.id}.json`), "utf8"));
    expect(stored.logs).toBeUndefined();
    // A later grant invalidates a prior successful attempt until its own result arrives.
    const nextGrant = await source.authorize({ ...claim, id: randomUUID(), requestId: randomUUID() });
    await expect(source.publish(claim.grant, evidence)).rejects.toBeInstanceOf(StaleExecutionSourceError);
    expect((await post(promotionPath, hostPromoterAuthorization, { schemaVersion: 1 })).status).toBe(409);
    await source.publish(nextGrant, result(nextGrant));
    expect((await post(promotionPath, hostPromoterAuthorization, { schemaVersion: 1 })).status).toBe(201);
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(native.root), "rev-parse", "refs/heads/main"])).stdout.trim())
      .toBe(envelope.review.candidateCommit);
  } finally { await ci.close(); await rm(directory, { recursive: true, force: true }); }
  function post(path: string, authorization: string, body: unknown) {
    return fetch(`${native.service.origin}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json", "X-Dim-Generation-Id": generationId }, body: JSON.stringify(body) });
  }
});
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
