import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult } from "../web-lifecycle/process.js";
import { OperatorInputError, smokeWorkspaceName, type OwnedWorkspace } from "./config.js";

export async function verifyAuxiliaryVm(input: {
  readonly workspace: OwnedWorkspace; readonly image: string; readonly startupTimeoutMilliseconds: number; readonly challenge: string;
  readonly run: (step: string, args: readonly string[], timeout?: number) => Promise<CommandResult>;
  readonly rejected: (step: string, args: readonly string[]) => Promise<void>;
}): Promise<{ readonly name: string; readonly id: string; readonly image: string }> {
  const name = smokeWorkspaceName("dim-smoke-vm"), root = await mkdtemp(path.join(tmpdir(), "dim-smoke-vm-source-"));
  let id: string | undefined, granted = false, failure: unknown;
  const startupCallerTimeout = input.startupTimeoutMilliseconds + 60_000;
  const guest = (...command: string[]) => ["exec", input.workspace.name, "--", ...command];
  try {
    const created: unknown = JSON.parse((await input.run("auxiliary VM creation", ["vm", "create", name, input.image], 180_000)).stdout);
    if (!created || typeof created !== "object" || !("id" in created) || typeof created.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(created.id)
      || !("name" in created) || created.name !== name) throw new OperatorInputError("VM creation did not return the exact owned identity; VM retained");
    id = created.id;
    await input.run("auxiliary VM readiness", ["vm", "start", name, "--expect-id", id], startupCallerTimeout);
    await input.run("explicit auxiliary VM grant", ["vm", "grant", name, input.workspace.name, "--lifecycle"]); granted = true;
    const discovery: unknown = JSON.parse((await input.run("agent VM capability discovery", guest("dim-workspace", "discovery"))).stdout);
    if (!discovery || typeof discovery !== "object" || !("capabilities" in discovery) || !Array.isArray(discovery.capabilities)
      || !discovery.capabilities.some((value: unknown) => value !== null && typeof value === "object" && "owner" in value && value.owner === "vm"
        && "name" in value && value.name === "auxiliary-vm-access" && "state" in value && value.state === "available")) throw new OperatorInputError("agent discovery did not advertise granted auxiliary VM access");
    const targets: unknown = JSON.parse((await input.run("agent VM target discovery", guest("dim-vm", "list"))).stdout);
    if (!Array.isArray(targets) || !targets.some((target: unknown) => target !== null && typeof target === "object" && "vmId" in target && target.vmId === id)) throw new OperatorInputError("agent did not discover the exact granted VM target");
    const script = path.join(root, "probe.cjs");
    await writeFile(script, `const fs=require("node:fs"),assert=require("node:assert/strict");assert.equal([1,2,3,4].reduce((a,b)=>a+b,0),10);fs.mkdirSync("/home/dim/acceptance",{recursive:true});fs.writeFileSync("/home/dim/acceptance/result",${JSON.stringify(input.challenge)});console.log("auxiliary-code-tested");\n`);
    await input.run("VM source to workspace", ["cp", script, `${input.workspace.name}:/home/dim/auxiliary-probe.cjs`]);
    await input.run("VM source transfer", guest("dim-vm", "push", name, "/home/dim/auxiliary-probe.cjs", "acceptance/probe.cjs"));
    await input.run("VM source build check", guest("dim-vm", "exec", name, "--", "node", "--check", "/home/dim/acceptance/probe.cjs"));
    await input.run("VM code test and artifact creation", guest("dim-vm", "exec", name, "--", "node", "/home/dim/acceptance/probe.cjs"));
    await input.run("VM artifact return", guest("dim-vm", "pull", name, "acceptance/result", "/home/dim/auxiliary-result"));
    if ((await input.run("VM artifact consumer readback", guest("cat", "/home/dim/auxiliary-result"))).stdout !== input.challenge) throw new OperatorInputError("VM artifact did not match the owned run challenge");
    await input.run("granted VM stop", guest("dim-vm", "stop", name), 180_000);
    await input.run("granted VM start", guest("dim-vm", "start", name), startupCallerTimeout);
    if ((await input.run("immediate post-start retained VM artifact", guest("dim-vm", "exec", name, "--", "cat", "/home/dim/acceptance/result"))).stdout !== input.challenge) throw new OperatorInputError("VM did not retain data or immediate guest readiness");
    await input.run("exact VM workspace revocation", ["vm", "revoke", name, input.workspace.id]); granted = false;
    await input.rejected("revoked VM access denial", guest("dim-vm", "status", name));
    return { name, id, image: input.image };
  } catch (error) {
    failure = error;
    throw new OperatorInputError(`auxiliary VM scenario failed for ${name} (${id ?? "identity unavailable; no unproven VM was discarded"}): ${error instanceof Error ? error.message : "unknown failure"}`, { cause: error });
  }
  finally {
    const cleanupErrors: unknown[] = [];
    if (id !== undefined) {
      if (granted) {
        try { await input.run("VM grant cleanup", ["vm", "revoke", name, input.workspace.id]); }
        catch (error) { cleanupErrors.push(error); }
      }
      try { await input.run("exact auxiliary VM cleanup", ["vm", "discard", name, "--expect-id", id], 180_000); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupErrors], `auxiliary VM cleanup needs inspection: ${name} (${id ?? "identity unavailable"})`);
  }
}
