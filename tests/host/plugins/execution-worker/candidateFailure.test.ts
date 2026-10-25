import { expect, it } from "vitest";
import { candidateFailureCode } from "../../../../packages/host/plugins/execution-worker/src/candidate-failure.js";
import { ExecutionLeaseLostError, ExecutionServiceUnavailableError,
  workerAdmissionTimeoutMilliseconds, workerOperationTimeoutMilliseconds } from "../../../../packages/host/plugins/execution-worker/src/client.js";
import { schedulerAdmissionTimeoutMilliseconds } from "../../../../packages/control-plane/plugins/execution-scheduler/src/admission.js";
import { gitAdmissionTimeoutMilliseconds } from "../../../../packages/control-plane/plugins/execution-scheduler/src/ci-source.js";
import { CandidateObjectError } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateObjects.js";

it("uses coherent worker admission and ordinary operation deadlines", () => {
  expect(workerAdmissionTimeoutMilliseconds).toBe(45_000);
  expect(workerOperationTimeoutMilliseconds).toBe(10_000);
  expect(gitAdmissionTimeoutMilliseconds).toBeLessThan(schedulerAdmissionTimeoutMilliseconds);
  expect(schedulerAdmissionTimeoutMilliseconds).toBeLessThan(workerAdmissionTimeoutMilliseconds);
});

it("maps only typed candidate transport failures to bounded public codes", () => {
  expect(candidateFailureCode(new ExecutionServiceUnavailableError("private", "timeout"))).toBe("candidate-read-timeout");
  expect(candidateFailureCode(new ExecutionServiceUnavailableError("private", "unavailable"))).toBe("candidate-read-unavailable");
  expect(candidateFailureCode(new ExecutionLeaseLostError("private"))).toBe("candidate-read-stale");
  expect(candidateFailureCode(new CandidateObjectError("private object/path"))).toBe("candidate-read-rejected");
  expect(candidateFailureCode(new Error("raw secret detail"))).toBeUndefined();
});
