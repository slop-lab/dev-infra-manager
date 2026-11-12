import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { sysboxAcquisitionFailure } from "./sysboxAcquisitionFixture.js";

it.each(["transport", "timeout", "cancel"] as const)("retains closed Git acquisition evidence before any runtime creation on %s", async (mode) => {
  // Given a real Git subprocess reading a disposable loopback responder.
  const expected = mode === "timeout" ? "candidate-read-timeout" : mode === "transport" ? "candidate-read-transport-failed" : "candidate-read-aborted";
  // When the actual Sysbox backend fails acquisition before reaching Docker launch.
  const { result, stderr, calls, requests, endpoint, secret, timeoutMilliseconds } = await sysboxAcquisitionFailure(mode);
  // Then status, retained bytes and closed metrics describe acquisition, not guest execution.
  expect(result.completion).toEqual(mode === "cancel" ? { kind: "cancelled" } : { kind: "executor-failure", code: expected });
  expect(result.result).toBe(mode === "cancel" ? "cancelled" : "failure");
  expect(result.cleanupComplete).toBe(true);
  expect(requests).toBe(1);
  expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([["container", "inspect"]]);
  expect(Buffer.from(result.logs.stderr.base64, "base64")).toEqual(stderr);
  expect(result.stderr).toEqual({ bytes: String(stderr.length), sha256: `sha256:${createHash("sha256").update(stderr).digest("hex")}`, truncated: false });
  const records = stderr.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(records).toEqual([
    { component: "candidate-acquisition", phase: "candidate-acquisition", event: "start" },
    { component: "candidate-acquisition", phase: "credential-acquisition", event: "start" },
    { component: "candidate-acquisition", phase: "credential-acquisition", event: "finish", status: "success", elapsedMilliseconds: expect.any(Number) },
    { component: "candidate-acquisition", phase: "candidate-fetch", event: "start" },
    { component: "candidate-acquisition", phase: "candidate-fetch", event: "finish", status: "failure", timeoutMilliseconds,
      elapsedMilliseconds: expect.any(Number), stdoutBytes: 0, stderrBytes: expect.any(Number), exitCode: mode === "transport" ? 128 : null,
      ...(mode === "transport" ? {} : { termination: mode === "timeout" ? "timeout" : "aborted" }) },
    { component: "candidate-acquisition", phase: "candidate-acquisition", event: "finish", status: "failure", elapsedMilliseconds: expect.any(Number) },
    { component: "candidate-acquisition", phase: "candidate-fetch", code: expected },
  ]);
  const fetch = records[4];
  expect(fetch.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  expect(fetch.stdoutBytes).toBe(0);
  expect(fetch.stderrBytes).toBeGreaterThanOrEqual(0);
  expect(fetch.exitCode).toBe(mode === "transport" ? 128 : null);
  if (mode !== "transport") expect(fetch.termination).toBe(mode === "timeout" ? "timeout" : "aborted");
  for (const privateValue of [endpoint, secret, "private-reader", "private-repository", "x-private"]) expect(stderr.toString()).not.toContain(privateValue);
});
