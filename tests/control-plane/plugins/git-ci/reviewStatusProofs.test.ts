import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { executionGrantSchema } from "@slop-lab/dim-contracts-ci/execution";
import * as rootProofGit from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-import-proof-git.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewerAuthorization } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../git-repositories/bundleConfigFixture.js";
import { result, slot } from "../../../contracts/ci/executionFixture.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupFinalizeFixtures(); });

it("shares one full proof across required CI jobs but proves storage again on the next HTTP request", async () => {
  // Given: two required jobs have actual grant/result records from the authority HTTP API.
  const f = await nativeBundleReviewFixture("ci-status-proof-reuse");
  const envelope = (await publishedReviewEnvelopes(f.root))[0];
  if (!envelope || envelope.events.length !== 2) throw new Error("two-job plan is missing");
  const post = (path: string, credential: { readonly username: string; readonly password: string }, body: unknown) => fetch(f.service.origin + path, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      "x-dim-generation-id": generationId, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const config = idleNativeConfig();
  for (const event of envelope.events) {
    const response = await post("/v1/execution-grants", config.ci.grantIssuer, { executionId: randomUUID(), generationId, event,
      workerId: "worker-a", slotId: "primary", profile: slot.profile });
    expect(response.status, await response.clone().text()).toBe(201);
    const grant = executionGrantSchema.parse(await response.json());
    const { logs: _logs, ...output } = result(grant);
    const evidence = await post(`/v1/executions/project-a/root/${grant.executionId}/evidence`, config.ci.resultReporter, output);
    expect(evidence.status, await evidence.clone().text()).toBe(201);
  }
  const read = () => fetch(`${f.service.origin}/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}/ci`, {
    headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId }
  });
  const proofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootReadOnly");

  // When
  const first = await read();

  // Then
  expect(first.status, await first.clone().text()).toBe(200);
  expect(await first.json()).toMatchObject({ state: "succeeded", requiredJobs: [{ status: "succeeded" }, { status: "succeeded" }] });
  expect(proofs).toHaveBeenCalledTimes(1);
  expect((await read()).status).toBe(200);
  expect(proofs).toHaveBeenCalledTimes(2);
}, 30_000);
