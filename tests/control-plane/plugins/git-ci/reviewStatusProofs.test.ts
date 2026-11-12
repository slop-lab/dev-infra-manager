import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import * as evidenceReader from "../../../../packages/control-plane/plugins/git-ci/src/execution-evidence.js";
import { readWorkspaceCiStatus } from "../../../../packages/control-plane/plugins/git-ci/src/workspace-status.js";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { encodeDimReviewJobAvailableEvent, executionGrantSchema } from "@slop-lab/dim-contracts-ci/execution";
import * as rootProofGit from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-import-proof-git.js";
import { nativeBundleReviewFixture, publishedReviewEnvelopes } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId, humanReviewerAuthorization, rootRepository } from "../git-repositories/nativeRootImportFinalizeFixture.js";
import { idleNativeConfig } from "../git-repositories/bundleConfigFixture.js";
import { result, slot } from "../../../contracts/ci/executionFixture.js";
import { assertCurrentExecution, currentExecutionEvidence } from "../../../../packages/control-plane/plugins/git-ci/src/execution-evidence.js";
import { dimWorkflowCompiler } from "../../../../packages/control-plane/plugins/ci-workflows/src/index.js";

afterEach(async () => { vi.restoreAllMocks(); await cleanupFinalizeFixtures(); });

it("revalidates selected-root authority on each CI status HTTP request without whole-store attestation", async () => {
  // Given: two required jobs have actual grant/result records from the authority HTTP API.
  const f = await nativeBundleReviewFixture("ci-status-proof-reuse");
  const envelope = (await publishedReviewEnvelopes(f.root))[0];
  if (!envelope || envelope.events.length !== 2) throw new Error("two-job plan is missing");
  const post = (path: string, credential: { readonly username: string; readonly password: string }, body: unknown) => fetch(f.service.origin + path, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      "x-dim-generation-id": generationId, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const config = idleNativeConfig();
  let firstGrant: ReturnType<typeof executionGrantSchema.parse> | undefined;
  for (const event of envelope.events) {
    const response = await post("/v1/execution-grants", config.ci.grantIssuer, { executionId: randomUUID(), generationId,
      event: encodeDimReviewJobAvailableEvent(event),
      workerId: "worker-a", slotId: "primary", profile: slot.profile });
    expect(response.status, await response.clone().text()).toBe(201);
    const grant = executionGrantSchema.parse(await response.json());
    firstGrant ??= grant;
    // Pending attempts do not establish a gate and must not reload promotion inputs.
    const compiler = { ...dimWorkflowCompiler, compile: vi.fn(() => { throw new Error("pending attempt reloaded workflow"); }) };
    await expect(currentExecutionEvidence({ ...f.service.context.runtime, expectedGenerationId: generationId,
      workflowCompiler: compiler }, rootRepository(f.root), event)).rejects.toMatchObject({ code: "evidence-missing" });
    expect(compiler.compile).not.toHaveBeenCalled();
    const { logs: _logs, ...output } = result(grant);
    const evidence = await post(`/v1/executions/project-a/root/${grant.executionId}/evidence`, config.ci.resultReporter, output);
    expect(evidence.status, await evidence.clone().text()).toBe(201);
    expect((await post(`/v1/executions/project-a/root/${grant.executionId}/evidence`, config.ci.resultReporter, output)).status).toBe(201);
  }
  const read = () => fetch(`${f.service.origin}/v1/projects/project-a/repositories/root/reviews/${envelope.review.reviewId}/ci`, {
    headers: { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId }
  });
  const liveProofs = vi.spyOn(rootProofGit, "inspectImportedNativeRootLive");

  // When
  const first = await read();

  // Then
  expect(first.status, await first.clone().text()).toBe(200);
  expect(await first.json()).toMatchObject({ state: "succeeded", requiredJobs: [{ status: "succeeded" }, { status: "succeeded" }] });
  const firstLiveProofs = liveProofs.mock.calls.length;
  expect(firstLiveProofs).toBeGreaterThan(0);
  expect((await read()).status).toBe(200);
  expect(liveProofs.mock.calls.length).toBeGreaterThan(firstLiveProofs);
  await expect(currentExecutionEvidence({ ...f.service.context.runtime,
    expectedGenerationId: "b".repeat(64), workflowCompiler: dimWorkflowCompiler }, rootRepository(f.root), envelope.events[0]!))
    .rejects.toMatchObject({ code: "evidence-missing" });
  // Required gates and the displayed job list share validation only within one status request.
  const runtime = { ...f.service.context.runtime, expectedGenerationId: generationId, workflowCompiler: dimWorkflowCompiler };
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: "project-a", repositoryId: "root" });
  const evidenceReads = vi.spyOn(evidenceReader, "currentExecutionEvidence");
  expect(await readWorkspaceCiStatus(runtime, target, envelope.review.reviewId)).toMatchObject({ state: "succeeded", jobs: [{ status: "succeeded" }, { status: "succeeded" }] });
  expect(evidenceReads).toHaveBeenCalledTimes(2);
  expect(await readWorkspaceCiStatus(runtime, target, envelope.review.reviewId)).toMatchObject({ state: "succeeded" });
  expect(evidenceReads).toHaveBeenCalledTimes(4);
  if (!firstGrant) throw new Error("execution grant is missing");
  await expect(assertCurrentExecution({ ...f.service.context.runtime,
    expectedGenerationId: "b".repeat(64), workflowCompiler: dimWorkflowCompiler }, firstGrant)).rejects.toThrow(/generation is stale/);
}, 30_000);
