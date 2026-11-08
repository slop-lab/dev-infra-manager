import { expect, it } from "vitest";
import { waitForIncusCloudInit } from "./incusReadiness.ts";
import { CommandFailure, type CommandResult } from "../../web-lifecycle/process.ts";
const ready = { exitCode: 0, stdout: "status: done\n", stderr: "" };
const unavailable = { exitCode: 255, stdout: "", stderr: "Error: Failed to connect to the agent\n" };
const interrupted = { exitCode: 255, stdout: "..............................", stderr: "Error: local error: tls: bad record MAC\n" };
function fixture(results: CommandResult[]) {
  let clock = 0;
  const calls: { file: string; args: readonly string[]; timeout: number | undefined }[] = [], reports: string[] = [];
  return { calls, reports, get clock() { return clock; }, operations: {
    now: () => clock,
    pause: async (milliseconds: number) => { clock += milliseconds; },
    report: (message: string) => { reports.push(message); },
    run: async (file: string, args: readonly string[], options?: { timeoutMs?: number }) => {
      calls.push({ file, args, timeout: options?.timeoutMs });
      return results.shift() ?? interrupted;
    }
  } };
}
it("reconnects the exact read-only status stream and requires a real successful completion", async () => {
  const f = fixture([interrupted, ready]);
  await waitForIncusCloudInit(5000, f.operations);
  expect(f.calls).toHaveLength(2);
  for (const call of f.calls) expect(call).toMatchObject({ file: "sudo", args: ["incus", "--force-local", "--project", "practical-ci", "exec", "practical-ci-image-builder", "--", "cloud-init", "status", "--wait"] });
  expect(f.calls.map(({ timeout }) => timeout)).toEqual([5000, 4000]);
  expect(f.reports).toEqual(["[practical-ci] cloud-init status attempt=1 transport=tls-bad-record-mac; reconnecting read-only status"]);
});
it("reconnects the observed TLS then unavailable-agent sequence within the original deadline", async () => {
  const f = fixture([interrupted, unavailable, ready]);
  await waitForIncusCloudInit(5000, f.operations);
  expect(f.calls.map(({ timeout }) => timeout)).toEqual([5000, 4000, 3000]);
  for (const call of f.calls) expect(call).toMatchObject({ file: "sudo", args: ["incus", "--force-local", "--project", "practical-ci", "exec", "practical-ci-image-builder", "--", "cloud-init", "status", "--wait"] });
  expect(f.reports).toEqual([
    "[practical-ci] cloud-init status attempt=1 transport=tls-bad-record-mac; reconnecting read-only status",
    "[practical-ci] cloud-init status attempt=2 transport=agent-unavailable; reconnecting read-only status"
  ]);
});
it("treats only the exact agent-unavailable response as not-ready even before a TLS interruption", async () => {
  const f = fixture([unavailable, ready]);
  await waitForIncusCloudInit(5000, f.operations);
  expect(f.calls.map(({ timeout }) => timeout)).toEqual([5000, 4000]);
  expect(f.reports).toEqual(["[practical-ci] cloud-init status attempt=1 transport=agent-unavailable; reconnecting read-only status"]);
});
it("never accepts a permanently unavailable agent or extends its fixed status deadline", async () => {
  const f = fixture([unavailable, unavailable, unavailable]);
  await expect(waitForIncusCloudInit(2500, f.operations)).rejects.toThrow("readiness deadline expired");
  expect(f.clock).toBe(2500);
  expect(f.calls.map(({ timeout }) => timeout)).toEqual([2500, 1500, 500]);
  expect(f.reports).toHaveLength(3);
});
it("retains one fixed deadline across persistent transport failures", async () => {
  const f = fixture([]);
  await expect(waitForIncusCloudInit(2500, f.operations)).rejects.toThrow("readiness deadline expired");
  expect(f.clock).toBe(2500);
  expect(f.calls.map(({ timeout }) => timeout)).toEqual([2500, 1500, 500]);
});
it.each([
  { exitCode: 1, stdout: "status: error", stderr: "cloud-init guest setup failed" },
  { exitCode: 255, stdout: "", stderr: "Error: agent connection failed" },
  { exitCode: 1, stdout: "", stderr: interrupted.stderr },
  { exitCode: 255, stdout: "", stderr: interrupted.stderr + "another error" },
  { ...unavailable, exitCode: 1 },
  { ...unavailable, stdout: "status: error" },
  { ...unavailable, stderr: unavailable.stderr + "another error" },
  { ...unavailable, stderr: "Error: Failed to connect to the agent: x509: certificate signed by unknown authority" },
  { ...unavailable, stderr: "Error: Failed to connect to the agent: authentication failed" }
])("fails immediately for a guest failure or an unclassified transport result ($exitCode)", async (failure) => {
  const f = fixture([failure, ready]);
  await expect(waitForIncusCloudInit(5000, f.operations)).rejects.toBeInstanceOf(CommandFailure);
  expect(f.calls).toHaveLength(1); expect(f.reports).toEqual([]);
});
it("does not start a status command after the existing readiness deadline", async () => {
  const f = fixture([ready]);
  await expect(waitForIncusCloudInit(0, f.operations)).rejects.toThrow("readiness deadline expired");
  expect(f.calls).toEqual([]);
});
it("rejects a successful status result received after the original deadline", async () => {
  let clock = 0;
  await expect(waitForIncusCloudInit(1000, {
    now: () => clock,
    run: async () => { clock = 1000; return ready; }
  })).rejects.toThrow("readiness deadline expired");
});
it("rejects a late successful reconnect after the existing deadline", async () => {
  let clock = 0, calls = 0;
  await expect(waitForIncusCloudInit(2000, {
    now: () => clock,
    pause: async milliseconds => { clock += milliseconds; },
    report: () => {},
    run: async () => { calls++; if (calls === 1) return unavailable; clock = 2000; return ready; }
  })).rejects.toThrow("readiness deadline expired");
  expect(calls).toBe(2);
});
