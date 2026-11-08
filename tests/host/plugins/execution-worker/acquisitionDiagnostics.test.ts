import { Writable } from "node:stream";
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

it("emits bounded phase success/failure timing and preserves the original error even if presentation fails", async () => {
  let captured = "";
  const output = new Writable({ write(chunk, _encoding, done) { captured += chunk.toString(); done(); } }), before = performance.now();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const pending = acquisitionOperation("materialize", () => gate, output);
  expect(JSON.parse(captured)).toEqual({ component: "candidate-acquisition", phase: "materialize", event: "start" });
  finish(); await pending;
  const events = captured.trim().split("\n").map(line => JSON.parse(line));
  expect(events[1]).toMatchObject({ phase: "materialize", event: "finish", status: "success", elapsedMilliseconds: expect.any(Number) });
  expect(events[1].elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  expect(events[1].elapsedMilliseconds).toBeLessThanOrEqual(Math.ceil(performance.now() - before));
  const error = new NativeGitProcessError("PRIVATE_TOKEN_URL", "timeout");
  const brokenSink = { write() { throw new Error("PRIVATE_SINK_FAILURE"); } } as unknown as import("node:stream").Writable;
  await expect(acquisitionOperation("candidate-fetch", async () => { throw error; }, brokenSink)).rejects.toBe(error);
});
