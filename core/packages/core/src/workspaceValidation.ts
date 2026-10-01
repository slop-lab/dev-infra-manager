import { stat } from "node:fs/promises";
import { UserError } from "./errors.js";
import type {
  WorkspaceCapabilityRecord,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import type { RegisteredDimPlugins, WorkspaceCapabilityContext } from "./plugin.js";

export function validateWorkspaceResources(resources: {
  cpuCount: string;
  memory: string;
  pidsLimit: string;
}): void {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpuCount) || Number(resources.cpuCount) <= 0) {
    throw new UserError("workspace CPU limit must be a positive number");
  }
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(resources.memory)) {
    throw new UserError("workspace memory limit must be a positive container memory size");
  }
  if (!/^[1-9][0-9]*$/.test(resources.pidsLimit)) {
    throw new UserError("workspace PID limit must be a positive integer");
  }
}

export function validateWorkspaceProfiles(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) || value.includes(",")) {
      throw new UserError(`workspace profile '${value}' must match [a-z0-9][a-z0-9_.-]{0,63}`);
    }
    if (seen.has(value)) throw new UserError(`workspace profile '${value}' is duplicated`);
    seen.add(value);
  }
  return [...seen];
}

export async function resolveWorkspaceCapabilities(
  requirements: { readonly required: readonly string[]; readonly recommended: readonly string[] },
  context: WorkspaceCapabilityContext,
  providers: RegisteredDimPlugins["workspaceCapabilityProviders"]
): Promise<WorkspaceCapabilityRecord[]> {
  const requests = [...requirements.required.map((name) => ({ name, requirement: "required" as const })),
    ...requirements.recommended.map((name) => ({ name, requirement: "recommended" as const }))];
  const seen = new Set<string>();
  const resolved: WorkspaceCapabilityRecord[] = [];
  for (const request of requests) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(request.name)) {
      throw new UserError(`workspace capability '${request.name}' has an invalid name`);
    }
    if (seen.has(request.name)) throw new UserError(`workspace capability '${request.name}' is duplicated`);
    seen.add(request.name);
    const registered = providers.get(request.name);
    if (!registered) {
      if (request.requirement === "required") {
        throw new UserError(`required workspace capability '${request.name}' has no installed provider`);
      }
      resolved.push({ ...request, status: "unavailable", detail: "no installed provider" });
      continue;
    }
    try {
      const provision = await registered.provider.provision(context);
      const capabilities = [...(provision.capabilities ?? [])];
      const securityOptions = [...(provision.securityOptions ?? [])];
      const devices = [...(provision.devices ?? [])];
      const environment = { ...(provision.environment ?? {}) };
      if (capabilities.some((value) => !/^[A-Z][A-Z0-9_]*$/.test(value))) {
        throw new UserError("provider returned an invalid Linux capability");
      }
      if (securityOptions.some((value) => value.length === 0 || value.includes("\0"))) {
        throw new UserError("provider returned an invalid security option");
      }
      if (devices.some((value) => !value.startsWith("/") || value.includes("\0"))) {
        throw new UserError("provider returned an invalid device path");
      }
      if (Object.entries(environment).some(([key, value]) =>
        !/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes("\0"))) {
        throw new UserError("provider returned an invalid environment entry");
      }
      resolved.push({ ...request, status: "provided", plugin: registered.plugin,
        ...(provision.detail ? { detail: provision.detail } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(securityOptions.length ? { securityOptions } : {}),
        ...(devices.length ? { devices } : {}),
        ...(Object.keys(environment).length ? { environment } : {}) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (request.requirement === "required") {
        throw new UserError(`required workspace capability '${request.name}' could not be provided: ${detail}`);
      }
      resolved.push({ ...request, status: "unavailable", plugin: registered.plugin, detail });
    }
  }
  return resolved;
}

export async function detectWorkspaceKvm(
  backend: WorkspaceRecord["runtimeBackend"],
  probe: () => Promise<void> = probeKvmDevice
): Promise<boolean> {
  if (backend !== "sysbox") return false;
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceKvm(
  backend: WorkspaceRecord["runtimeBackend"],
  requested: boolean | undefined,
  probe: () => Promise<void> = probeKvmDevice
): Promise<boolean> {
  const available = await detectWorkspaceKvm(backend, probe);
  if (requested === true && !available) {
    throw new UserError(`workspace KVM was requested but is unavailable for backend '${backend}'`);
  }
  return requested ?? available;
}

export async function probeKvmDevice(): Promise<void> {
  const device = await stat("/dev/kvm");
  if (!device.isCharacterDevice()) throw new Error("/dev/kvm is not a character device");
}
