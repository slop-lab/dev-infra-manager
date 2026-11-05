import { readFile } from "node:fs/promises";
import { deployGuestIntegration, UserError, workspaceCopyGuest, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceCapabilityFact, WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { VmAccessService } from "./access.js";
import { serveVmAccess } from "./accessServer.js";
import { CommandVmBudget } from "./budget-helper.js";
import { readVmHostConfig } from "./config.js";
import { IncusMachines } from "./incus.js";
import { PersistentVmService } from "./store.js";

const servers = new Map<string, Promise<{ readonly endpoint: string; readonly close: () => void }>>();

export async function deployVmAccess(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void> {
  if (!workspace.initialized || workspace.phase !== "running") return;
  const client = await readFile(new URL("./assets/dim-vm.mjs", import.meta.url));
  await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, { name: "vm-access", files: [
    { path: ".local/bin/dim-vm", contents: client, mode: 0o700 },
    { path: ".local/share/dim-vm/copy.cjs", contents: `process.argv.splice(1,1);\n${workspaceCopyGuest}`, mode: 0o700 }
  ] });
}

export async function inspectVmAccess(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  if (!workspace.initialized || workspace.phase !== "running") return { state: "unconfigured" as const, message: "Start the workspace to prepare VM access" };
  try { readVmHostConfig(context.stateRoot); }
  catch { return { state: "unconfigured" as const, message: "VM host integration is not configured on the selected host" }; }
  const targets = await vmAccess(context).discover(workspace);
  return targets.length ? { state: "ready" as const, message: `Use dim-vm list; ${targets.length} auxiliary VM grant(s) are available` }
    : { state: "unconfigured" as const, message: "VM client is ready; an operator must grant an auxiliary VM to this workspace" };
}

export async function vmCapabilities(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<readonly WorkspaceCapabilityFact[]> {
  let targets;
  try { targets = await vmAccess(context).discover(workspace); }
  catch {
    return [{ name: "auxiliary-vm-access", description: "Operator-granted auxiliary VM guest access", state: "blocked",
      reason: { code: "vm-host-unconfigured", message: "The selected host has no reviewed VM configuration" }, access: { kind: "none" } }];
  }
  return targets.length ? [{ name: "auxiliary-vm-access", description: "Operator-granted auxiliary VM guest access", state: "available",
    access: { kind: "guest-operation", operation: "list" } }]
    : [{ name: "auxiliary-vm-access", description: "Operator-granted auxiliary VM guest access", state: "blocked",
      reason: { code: "vm-grant-required", message: "An operator must grant an auxiliary VM to this workspace" }, access: { kind: "none" } }];
}

export async function listVmAccess(input: unknown, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  if (!plainEmptyObject(input)) throw new UserError("VM list accepts no input");
  return vmAccess(context).discover(workspace);
}

export const vmWorkspaceServices = {
  names: ["vm"] as const,
  async resolve(name: string, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<string | undefined> {
    if (name !== "vm" || !(await vmAccess(context).discover(workspace)).length) return;
    const service = await vmServer(context); return service.endpoint;
  }
};

function vmAccess(context: WorkspaceHostPluginContext): VmAccessService {
  const config = readVmHostConfig(context.stateRoot);
  if (!config.budgetHelper) throw new UserError("VM host requires the reviewed budget helper");
  const machines = new IncusMachines(config, context.runner, new CommandVmBudget(context.runner, config.budgetHelper), context.cleanupRunner,
    new CommandVmBudget(context.cleanupRunner, config.budgetHelper));
  return new VmAccessService(new PersistentVmService(context.stateRoot, machines, context.store));
}

async function vmServer(context: WorkspaceHostPluginContext) {
  let current = servers.get(context.stateRoot);
  if (!current) {
    current = (async () => {
      const server = await serveVmAccess(vmAccess(context), { host: "127.0.0.1", port: 0 });
      const address = server.address(); if (!address || typeof address === "string") throw new UserError("VM access listener is unavailable");
      const close = () => server.close();
      context.signal.addEventListener("abort", close, { once: true });
      server.once("close", () => { context.signal.removeEventListener("abort", close); servers.delete(context.stateRoot); });
      return { endpoint: `http://127.0.0.1:${address.port}`, close };
    })();
    servers.set(context.stateRoot, current);
  }
  return current;
}

function plainEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}
