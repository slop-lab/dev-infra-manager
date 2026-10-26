import { expect, it } from "vitest";
import { CandidateCiError, verifyWorkspaceCandidateCi } from "./candidateCi.js";

const candidateCommit = "a".repeat(40), candidateRef = "refs/heads/smoke/fixture", reviewId = "b".repeat(64);
function response(args: readonly string[], state: "pending" | "succeeded" | "not-required") {
  const requestId = args[args.indexOf("--request-id") + 1];
  const jobs = state === "not-required" ? [] : [{ name: "source", kind: "ordinary-sysbox", status: state }];
  return { schemaVersion: 1, requestId, reviewId, candidateRef, candidateCommit, status: { state, jobs,
    review: { schemaVersion: 1, reviewId, generationId: "c".repeat(64), candidateCommit, expectedProtectedHead: "d".repeat(40),
      policy: "enabled", state, requiredJobs: jobs } } };
}
it("validates exact retry identity and required-job evidence using offline metadata", async () => {
  const commands: string[][] = [];
  await verifyWorkspaceCandidateCi({ workspace: "dim-smoke-fixture", candidateRef, candidateCommit, progress: () => {},
    run: async (_step, args) => {
      commands.push([...args]);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(response(args, commands.length === 1 ? "pending" : "succeeded")) };
    } });
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
});
it("does not count an enabled policy with no required jobs as successful required CI", async () => {
  await expect(verifyWorkspaceCandidateCi({ workspace: "dim-smoke-fixture", candidateRef, candidateCommit, progress: () => {},
    run: async (_step, args) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(response(args, "not-required")) }) })).rejects.toBeInstanceOf(CandidateCiError);
});
it("rejects success metadata bound to another candidate even when its transport succeeded", async () => {
  await expect(verifyWorkspaceCandidateCi({ workspace: "dim-smoke-fixture", candidateRef, candidateCommit, progress: () => {},
    run: async (_step, args) => {
      const value = response(args, "succeeded"); value.status.review.candidateCommit = "e".repeat(40);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
    } })).rejects.toBeInstanceOf(CandidateCiError);
});
