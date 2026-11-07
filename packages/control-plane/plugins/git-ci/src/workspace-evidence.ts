import type { createExecutionQueryClient } from "@slop-lab/dim-service-client-execution";
import { readAuthoritativeNativeReviewEnvelope } from "@slop-lab/gs-ci";
import type { AuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { StoredWorkspaceCiRequest } from "./workspace-candidate-http.js";

export type WorkspaceCiEvidenceClient = ReturnType<typeof createExecutionQueryClient>;
export interface WorkspaceCiEvidence { readonly contentType: string; readonly body: Buffer }

/** The request's immutable review plan, not a caller-provided execution ID, selects readable jobs. */
export async function workspaceCiEvidence(input: {
  readonly client: WorkspaceCiEvidenceClient; readonly target: AuthoritativeNativeRepositoryTarget;
  readonly request: StoredWorkspaceCiRequest; readonly reviewId: string; readonly suffix: string;
}): Promise<WorkspaceCiEvidence | undefined> {
  const { client, target, request, reviewId, suffix } = input;
  const plan = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (!plan || plan.planning.status !== "valid" || plan.review.candidateCommit !== request.candidateCommit
    || plan.review.candidateTree !== request.candidateTree || plan.review.namespaceId !== request.projectId
    || plan.review.repositoryId !== request.repositoryId || plan.policyDigest !== request.policyDigest) return;
  const jobs = [];
  for (const event of plan.events) {
    if (event.namespaceId !== request.projectId || event.repositoryId !== request.repositoryId || event.reviewId !== reviewId
      || event.candidateCommit !== request.candidateCommit || event.candidateTree !== request.candidateTree) return;
    const found = await client.byEvent(event.eventId);
    for (const detail of found.jobs) {
      const { job } = detail;
      if (job.eventId !== event.eventId || job.projectId !== request.projectId || job.repositoryId !== request.repositoryId
        || job.generationId !== request.generationId || job.jobName !== event.checkName || job.executionKind !== event.provider
        || detail.result !== undefined && detail.result.executionId !== job.id) return;
      jobs.push(detail);
    }
  }
  const json = (value: unknown): WorkspaceCiEvidence => ({ contentType: "application/json", body: Buffer.from(JSON.stringify(value)) });
  if (suffix === "/jobs") return json({ schemaVersion: 1, requestId: request.requestId,
    candidateCommit: request.candidateCommit, candidateTree: request.candidateTree,
    jobs: jobs.map(({ job, result }) => ({ ...job, ...(result ? { descriptorDigest: result.descriptorDigest } : {}) })) });
  const match = /^\/jobs\/([0-9a-f-]{36})\/(logs|artifacts)(?:\/([0-9a-f]{64}))?$/.exec(suffix);
  if (!match) return;
  const detail = jobs.find(({ job }) => job.id === match[1]);
  if (!detail) return;
  if (match[2] === "logs") {
    if (match[3] || !detail.result) return;
    return json({ schemaVersion: 1, requestId: request.requestId, job: detail.job, result: detail.result });
  }
  if (!detail.result) return;
  const manifest = await client.artifacts(detail.job.id);
  if (manifest.executionId !== detail.job.id || manifest.descriptorDigest !== detail.result.descriptorDigest) return;
  if (!match[3]) return json(manifest);
  const artifact = manifest.artifacts.find(({ id }) => id === match[3]);
  if (!artifact) return;
  // The execution client validates the digest and bounded size against its immutable manifest.
  const bytes = await client.artifact(detail.job.id, artifact.id);
  return { contentType: "application/octet-stream", body: bytes };
}
