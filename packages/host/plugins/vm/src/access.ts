import { randomUUID } from "node:crypto";
import path from "node:path";
import { UserError, workspaceCopyCleanup, workspaceCopyGuest, workspaceCopyMarker,
  type RunOptions, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { PersistentVmService, type VmAuthorization, type VmPermission } from "./store.js";

export interface VmAccessIdentity {
  readonly token: string;
  readonly grantId: string;
  readonly generation: number;
  readonly vmId: string;
  readonly vmName: string;
  readonly workspaceId: string;
}

export interface VmAccessTarget {
  readonly vmId: string;
  readonly vmName: string;
  readonly running: boolean;
  readonly permissions: readonly VmPermission[];
}

export interface VmCopyInput extends VmAccessIdentity {
  readonly direction: "push" | "pull";
  readonly path: string;
  readonly recursive: boolean;
  readonly overwrite: boolean;
  readonly options?: RunOptions;
}

export class VmAccessService {
  constructor(readonly records: PersistentVmService) {}

  async discover(workspace: WorkspaceRecord): Promise<VmAccessTarget[]> {
    const targets: VmAccessTarget[] = [];
    for (const vm of await this.records.list()) {
      const grant = vm.grants.find((candidate) => candidate.workspaceId === workspace.id
        && candidate.workspaceName === workspace.name && candidate.permissions.includes("discover"));
      if (!grant) continue;
      targets.push({ vmId: vm.id, vmName: vm.name, running: (await this.records.machines.inspect(vm))?.running ?? false,
        permissions: grant.permissions });
    }
    return targets.sort((left, right) => left.vmName.localeCompare(right.vmName));
  }

  async status(identity: VmAccessIdentity): Promise<VmAccessTarget> {
    const access = await this.authorize(identity, "status");
    return { vmId: access.vm.id, vmName: access.vm.name, running: (await this.records.machines.inspect(access.vm))?.running ?? false,
      permissions: access.grant.permissions };
  }

  async exec(input: VmAccessIdentity & { readonly command: readonly string[]; readonly options?: RunOptions }): Promise<number> {
    const access = await this.authorize(input, "exec");
    return this.records.machines.exec(access.vm, [...input.command], input.options);
  }

  async lifecycle(input: VmAccessIdentity & { readonly operation: "start" | "stop" }): Promise<void> {
    await this.records.lifecycleAccess({ ...input, operation: input.operation });
  }

  async isAuthorized(identity: VmAccessIdentity, permission: VmPermission): Promise<boolean> {
    return await this.records.authorizeAccess(identity.vmName, identity.token, { permission, vmId: identity.vmId,
      workspaceId: identity.workspaceId, grantId: identity.grantId, generation: identity.generation }) !== undefined;
  }

  async copy(input: VmCopyInput): Promise<number> {
    const access = await this.authorize(input, "copy"), relative = vmPath(input.path);
    const target = path.posix.join("/home/dim", relative), token = randomUUID();
    const direction = input.direction === "push" ? "receive" : "send";
    let exitCode: number | undefined;
    let failure: unknown;
    try {
      exitCode = await this.records.machines.exec(access.vm, ["node", "--input-type=commonjs", "-e", workspaceCopyGuest,
        direction, target, input.recursive ? "1" : "0", input.overwrite ? "1" : "0", workspaceCopyMarker, "helper", token], input.options);
      return exitCode;
    } catch (error) { failure = error; throw error; }
    finally {
      if (exitCode !== 0 || input.options?.signal?.aborted || failure !== undefined) {
        const cleanup = await this.records.machines.exec(access.vm, ["node", "--input-type=commonjs", "-e", workspaceCopyCleanup,
          target, workspaceCopyMarker, "cleanup", token], { signal: AbortSignal.timeout(3000) });
        if (cleanup !== 0) throw new UserError("VM copy cleanup could not be confirmed");
      }
    }
  }

  private async authorize(identity: VmAccessIdentity, permission: VmPermission): Promise<VmAuthorization> {
    const access = await this.records.authorizeAccess(identity.vmName, identity.token, { permission, vmId: identity.vmId,
      workspaceId: identity.workspaceId, grantId: identity.grantId, generation: identity.generation });
    if (!access) throw new UserError("VM access denied or expired");
    return access;
  }
}

function vmPath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new UserError("invalid VM home-relative path");
  return value;
}
