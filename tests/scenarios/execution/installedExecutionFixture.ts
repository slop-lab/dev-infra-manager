import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionWorkerClient, isTaskAssignment } from "../../../packages/host/plugins/execution-worker/src/client.js";
import { nativeGitExecutionSource } from "../../../packages/control-plane/plugins/execution-scheduler/src/ci-source.js";
import { createNodeNativeGitAdmissionHttpClient } from "../../../packages/contracts/git/src/http.js";
import { executionServiceConfigSchema } from "../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes, reviewProposalRef } from "../../control-plane/plugins/git-ci/nativeBundleReviewFixture.js";
import { authoritativePolicy } from "../../control-plane/plugins/git-repositories/authoritativeNativeCandidateFixture.js";
import { idleExecutionConfig, bundleSecrets } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewerAuthorization, hostPromoterAuthorization,
  rootRepository, runGit } from "../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

/** Every call starts independent real Git authority, CI state and HTTP listeners. */
export async function installedExecutionFixture() {
  let ciOrigin: string | undefined, directory: string | undefined;
  let ci: ReturnType<typeof configuredExecutionServer> | undefined;
  let publicationAvailable = false;
  async function close() {
    const failures: unknown[] = [];
    try { await ci?.close(); } catch (error) { failures.push(error); }
    try { await cleanupFinalizeFixtures(); } catch (error) { failures.push(error); }
    if (directory !== undefined) {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "installed execution fixture cleanup failed");
  }
  try {
    const node = createNodeNativeGitAdmissionHttpClient();
    const native = await nativeBundleReviewFixture("installed-execution", undefined,
      authoritativePolicy(["owner"], [], [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }]),
      undefined, { async request(input) {
        if (ciOrigin === undefined) return { statusCode: 503, contentType: "application/json", cacheControl: "no-store", body: Buffer.from("{}") };
        return node.request({ ...input, endpoint: ciOrigin });
      } }, undefined, undefined, {}, undefined, "jobs:\n  source:\n    script: .dim/ci/jobs/source.bash\n");
    directory = await mkdtemp(join(tmpdir(), "dim-installed-execution-"));
    const config = executionServiceConfigSchema.parse(idleExecutionConfig());
    assert(config.nativeGit, "native execution fixture requires Git authority");
    const source = nativeGitExecutionSource(config.nativeGit, generationId,
      { request: (input) => node.request({ ...input, endpoint: native.service.origin }) });
    const service = configuredExecutionServer({ config, stateDirectory: directory, readinessToken: "ready", activationToken: "activate",
      expectedGenerationId: generationId, source: { ...source, async publish(grant, result) {
        if (!publicationAvailable) throw new Error("simulated Git publication outage");
        await source.publish(grant, result);
      } } });
    ci = service;
    await new Promise<void>((resolve, reject) => {
      service.server.once("error", reject);
      service.server.listen(0, "127.0.0.1", resolve);
    });
    const address = service.server.address(); assert(address && typeof address !== "string", "CI fixture listener is unavailable");
    const endpoint = `http://127.0.0.1:${address.port}`; ciOrigin = endpoint;
    const activated = await fetch(`${endpoint}/v1/activation`, { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { authorization: "Bearer activate", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId }) });
    assert.equal(activated.status, 200, "CI fixture activation failed");
    // NativeGit dispatches the actual candidate event; tests do not seed the queue.
    await waitFor("native candidate event intake", () => service.store.list().length === 1);
    const envelope = (await publishedReviewEnvelopes(native.root))[0]; assert(envelope, "native fixture review is missing");
    const worker = executionWorkerClient({ endpoint, workerId: "host-a", slotId: "primary", token: bundleSecrets.host, generationId });
    const promotionPath = `/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}/promotions`;
    function post(path: string, authorization: string, body: unknown) {
      return fetch(`${native.service.origin}${path}`, { method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { authorization, "content-type": "application/json", "X-Dim-Generation-Id": generationId }, body: JSON.stringify(body) });
    }
    return {
      native, ci: service, source, worker, envelope, close,
      setPublicationAvailable(value: boolean) { publicationAvailable = value; },
      async claim() {
        const assignment = await worker.claim(randomUUID());
        assert(assignment?.grant, "worker claim did not receive a native execution grant");
        assert(!isTaskAssignment(assignment), "CI fixture received a generic task");
        return { ...assignment, grant: assignment.grant };
      },
      accepted(id: string) { return waitFor(`Git publication of execution ${id}`, () => service.store.get(id).publication === "accepted"); },
      async approve() {
        const resolved = await post("/v1/projects/project-a/repositories/root/reviews/resolve", humanReviewerAuthorization,
          { schemaVersion: 1, proposalRef: reviewProposalRef });
        assert.equal(resolved.status, 200, "human review resolution failed");
        const approved = await post(`/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}/approvals`,
          humanReviewerAuthorization, { requestId: randomUUID() });
        assert.equal(approved.status, 201, "human approval publication failed");
      },
      promote() { return post(promotionPath, hostPromoterAuthorization, { schemaVersion: 1 }); },
      retry(id: string) {
        const credential = config.credentials.operator;
        return fetch(`${endpoint}/v1/operator/jobs/${id}/retry`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: {
          authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
          "content-type": "application/json", "X-Dim-Generation-Id": generationId
        }, body: JSON.stringify({ requestId: randomUUID() }) });
      },
      query(path: string) {
        const credential = config.credentials.query;
        assert(credential, "CI query credential is configured");
        return fetch(`${endpoint}${path}`, { signal: AbortSignal.timeout(10_000), headers: {
          authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
          "X-Dim-Generation-Id": generationId } });
      },
      async storedEvidence(id: string): Promise<unknown> {
        return JSON.parse(await readFile(join(rootRepository(native.root), "dim-execution-evidence", `${id}.json`), "utf8"));
      },
      async protectedHead() {
        return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(native.root), "rev-parse", "refs/heads/main"])).stdout.trim();
      }
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "installed execution fixture setup and cleanup failed"); }
    throw error;
  }
}
export type InstalledExecutionFixture = Awaited<ReturnType<typeof installedExecutionFixture>>;
async function waitFor(phase: string, predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${phase} did not complete within 10 seconds`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
