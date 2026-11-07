import { expect, it } from "vitest";
import { NativeOutputCollector } from "../../../../packages/host/plugins/execution-worker/src/output.js";
import { acquisitionOperation, writeAcquisitionDiagnostic } from "../../../../packages/host/plugins/execution-worker/src/acquisitionDiagnostics.js";
import { NativeGitProcessError } from "../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateProcess.js";
import { candidateFailureCode } from "../../../../packages/host/plugins/execution-worker/src/candidate-failure.js";

it("preserves exact failure identity and innermost trusted phase without serializing attacker-controlled fields", async () => {
  const error = new NativeGitProcessError("secret URL password", "timeout");
  Object.assign(error, { phase: "secret-phase", token: "secret-token" });
  const output = new NativeOutputCollector(1024, () => { throw new Error("unexpected overflow"); });
  const failed = acquisitionOperation("materialize", () => acquisitionOperation("source-context-fetch", async () => { throw error; }));
  await expect(failed).rejects.toBe(error);
  try { await failed; } catch (caught) { writeAcquisitionDiagnostic(output.stderr, caught, candidateFailureCode(caught)); }
  expect(output.result().stderr.toString()).toBe('{"component":"candidate-acquisition","phase":"source-context-fetch","code":"candidate-read-timeout"}\n');
});
it("does not log arbitrary errors that did not pass through the trusted acquisition boundary", () => {
  const output = new NativeOutputCollector(1024, () => {});
  writeAcquisitionDiagnostic(output.stderr, Object.assign(new Error("private"), { phase: "candidate-fetch" }), "candidate-read-timeout");
  expect(output.result().stderr.length).toBe(0);
});
