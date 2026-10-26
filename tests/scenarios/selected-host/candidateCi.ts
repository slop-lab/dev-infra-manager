import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { reviewCiJobSchema, reviewCiStatusSchema, type ReviewCiJob, type ReviewCiStatus } from "@slop-lab/dim-contracts-ci/review-status";
import type { CommandResult } from "../web-lifecycle/process.js";

type Receipt = { readonly requestId: string; readonly reviewId: string; readonly candidateRef: string; readonly candidateCommit: string;
  readonly state: ReviewCiStatus["state"]; readonly review: ReviewCiStatus; readonly jobs: readonly ReviewCiJob[] };
export class CandidateCiError extends Error { readonly name = "CandidateCiError"; }

export async function verifyWorkspaceCandidateCi(input: {
  readonly workspace: string; readonly candidateRef: string; readonly candidateCommit: string;
  readonly run: (step: string, args: readonly string[], timeoutMs: number) => Promise<CommandResult>;
  readonly progress: (step: string) => void;
}): Promise<void> {
  const requestId = randomUUID(), deadline = Date.now() + 10 * 60_000;
  let reviewId: string | undefined;
  const args = ["exec", input.workspace, "--", "dim-ci", "request", "--request-id", requestId, "--ref", input.candidateRef, "--commit", input.candidateCommit];
  const read = async (step: string, command: readonly string[]) => {
    const value = receipt((await input.run(step, command, Math.max(1, Math.min(170_000, deadline - Date.now())))).stdout);
    if (value.requestId !== requestId || value.candidateRef !== input.candidateRef || value.candidateCommit !== input.candidateCommit
      || value.review.candidateCommit !== input.candidateCommit || value.review.reviewId !== value.reviewId || reviewId !== undefined && value.reviewId !== reviewId) throw new CandidateCiError("CI response changed immutable candidate or request identity");
    reviewId ??= value.reviewId; return value;
  };
  let current = await read("exact workspace candidate CI request", args);
  if (current.requestId !== requestId || current.candidateRef !== input.candidateRef || current.candidateCommit !== input.candidateCommit) throw new CandidateCiError("CI receipt does not bind the exact pushed candidate");
  if (current.review.policy !== "enabled" || current.review.requiredJobs.length === 0) throw new CandidateCiError("selected Project must require at least one actual DIM CI job; absent policy is not successful evidence");
  input.progress(`CI request ${requestId} review ${current.reviewId}`);
  const repeated = await read("idempotent workspace CI request", args);
  if (repeated.requestId !== requestId || repeated.reviewId !== current.reviewId) throw new CandidateCiError("repeated CI request did not retain its immutable identity");
  current = repeated;
  let reads = 0;
  while (current.state === "pending" && Date.now() < deadline && reads++ < 120) {
    await delay(Math.min(5000, Math.max(1, deadline - Date.now())));
    current = await read("workspace required CI state", ["exec", input.workspace, "--", "dim-ci", "status", "--request-id", requestId]);
  }
  if (current.state !== "succeeded" || current.review.state !== "succeeded" || current.jobs.length === 0 || current.jobs.some((job) => job.status !== "succeeded")) {
    throw new CandidateCiError(`required candidate CI did not succeed (state=${current.state}); inspect the exact recorded request, do not automatically resubmit it`);
  }
  input.progress("actual required candidate CI succeeded; repeated request retained one immutable review");
}

function receipt(source: string): Receipt {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new CandidateCiError("CI helper did not return bounded JSON metadata"); }
  const row = object(value), status = object(row.status);
  if (row.schemaVersion !== 1 || typeof row.requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.requestId)
    || typeof row.reviewId !== "string" || !/^[a-f0-9]{64}$/.test(row.reviewId) || typeof row.candidateRef !== "string" || typeof row.candidateCommit !== "string"
    || !Array.isArray(status.jobs) || status.jobs.length > 512) throw new CandidateCiError("CI receipt identity or job inventory is invalid");
  const state = status.state;
  if (state !== "pending" && state !== "succeeded" && state !== "failed" && state !== "stale" && state !== "unavailable" && state !== "not-configured" && state !== "not-required") throw new CandidateCiError("CI state is unknown; no successful gate is established");
  try { return { requestId: row.requestId, reviewId: row.reviewId, candidateRef: row.candidateRef, candidateCommit: row.candidateCommit,
    state, review: reviewCiStatusSchema.parse(status.review), jobs: status.jobs.map((job: unknown) => reviewCiJobSchema.parse(job)) }; }
  catch { throw new CandidateCiError("CI evidence metadata is invalid; no successful gate is established"); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CandidateCiError("CI helper response is not a metadata object");
  return Object.fromEntries(Object.entries(value));
}
