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
    image: "a".repeat(64), challenge: "owned", run, rejected: async () => {} })).rejects.toThrow("auxiliary VM cleanup needs inspection");
  expect(received).toContainEqual(["vm", "discard", received[0]?.[2], "--expect-id", id]);
});
