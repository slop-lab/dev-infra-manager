import { expect, it } from "vitest";
import { verifyAuxiliaryVm } from "./auxiliaryVm.js";
import type { CommandResult } from "../web-lifecycle/process.js";

it("attempts UUID-pinned VM disposal even when grant cleanup fails", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const received: string[][] = [];
  const run = async (_step: string, args: readonly string[]): Promise<CommandResult> => {
    received.push([...args]);
    if (args[0] === "vm" && args[1] === "create") return { exitCode: 0, stdout: JSON.stringify({ id, name: args[2] }), stderr: "" };
    if (args[0] === "vm" && args[1] === "revoke") throw new Error("owned revocation failed");
    if (args[0] === "exec") throw new Error("capability connection unavailable");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await expect(verifyAuxiliaryVm({ workspace: { id: "22222222-2222-4222-8222-222222222222", name: "dim-smoke-workspace" },
    image: "a".repeat(64), startupTimeoutMilliseconds: 420_000, challenge: "owned", run, rejected: async () => {} })).rejects.toThrow("auxiliary VM cleanup needs inspection");
  expect(received).toContainEqual(["vm", "discard", received[0]?.[2], "--expect-id", id]);
});

it("allows the host startup policy plus cleanup margin for owner and granted starts", async () => {
  const id = "11111111-1111-4111-8111-111111111111", challenge = "retained";
  const bounds: Array<[string, number | undefined]> = [];
  const run = async (step: string, args: readonly string[], timeout?: number): Promise<CommandResult> => {
    bounds.push([step, timeout]);
    let stdout = "";
    if (step === "auxiliary VM creation") stdout = JSON.stringify({ id, name: args[2] });
    if (step === "agent VM capability discovery") stdout = JSON.stringify({ capabilities: [{ owner: "vm", name: "auxiliary-vm-access", state: "available" }] });
    if (step === "agent VM target discovery") stdout = JSON.stringify([{ vmId: id }]);
    if (step === "VM artifact consumer readback" || step === "immediate post-start retained VM artifact") stdout = challenge;
    return { exitCode: 0, stdout, stderr: "" };
  };
  await verifyAuxiliaryVm({ workspace: { id: "22222222-2222-4222-8222-222222222222", name: "dim-smoke-workspace" },
    image: "a".repeat(64), startupTimeoutMilliseconds: 420_000, challenge, run, rejected: async () => {} });
  expect(bounds).toContainEqual(["auxiliary VM readiness", 480_000]);
  expect(bounds).toContainEqual(["granted VM start", 480_000]);
  expect(bounds).toContainEqual(["exact auxiliary VM cleanup", 180_000]);
});
