import { ensureAptCache } from "./aptCache.js";
import { runDoctor } from "./doctor.js";
import { UserError } from "./errors.js";
import { HostNotReadyError, withHostAdminAdmission, withHostRuntimeAdmission } from "./hostAdminAdmission.js";
import { hostLifecycleStatus, shutdownHost, startHost } from "./hostLifecycle.js";
import { requireHostMirrorProvider, resolveHostMirrorProvider } from "./hostMirrorProvider.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import type { StreamingCommandRunner } from "./types.js";
import { ensureRegistryCache } from "./registryCache.js";
import * as workspaceLifecycle from "./workspaceLifecycle.js";
import { booleanValue, stringArray, stringValue, workspaceRuntimeBackend } from "./adminInput.js";

type BuiltinContext = {
  readonly input: Record<string, unknown>;
  readonly lifecycle: LifecycleOptions;
  readonly runner: StreamingCommandRunner;
  readonly plugins: RegisteredDimPlugins;
};

export async function adminBuiltinCall(operation: string, context: BuiltinContext): Promise<unknown> {
  const hostMirrorProvider = resolveHostMirrorProvider(context.plugins.host);
  const lifecycle = hostMirrorProvider === undefined
    ? context.lifecycle
    : { ...context.lifecycle, hostMirrorProvider };
  switch (operation) {
    case "host.status":
      return hostLifecycleStatus(lifecycle);
    case "host.shutdown":
      return shutdownHost(context.runner, lifecycle);
    case "host.start":
      return startHost(context.runner, lifecycle);
    default:
      try {
        const admit = RUNTIME_OPERATIONS.has(operation) ? withHostRuntimeAdmission : withHostAdminAdmission;
        return await admit(lifecycle, () => dispatchBuiltin(operation, { ...context, lifecycle }));
      } catch (error) {
        if (error instanceof HostNotReadyError) {
          throw new UserError(`DIM host is ${error.phase}; run dim host start before '${operation}'`);
        }
        throw error;
      }
  }
}

const RUNTIME_OPERATIONS = new Set(["workspace.exec", "workspace.run"]);

async function dispatchBuiltin(operation: string, context: BuiltinContext): Promise<unknown> {
  const { input, runner, plugins } = context;
  const hostMirrorProvider = resolveHostMirrorProvider(plugins.host);
  const lifecycle = hostMirrorProvider === undefined
    ? context.lifecycle
    : { ...context.lifecycle, hostMirrorProvider };
  if (MIRROR_REQUIRED_OPERATIONS.has(operation)) {
    requireHostMirrorProvider(hostMirrorProvider);
    await ensureRegistryCache(runner, lifecycle);
    await ensureAptCache(runner, lifecycle);
  }
  const text = (name: string) => stringValue(input[name], name);
  switch (operation) {
    case "workspace.create":
      if (input.repositoryRefs !== undefined) {
        throw new UserError("workspace repository ref overrides are obsolete; define non-root ref policy in reviewed Project code");
      }
      return workspaceLifecycle.createWorkspace(runner, lifecycle, {
        project: text("project"),
        name: text("name"),
        profiles: stringArray(input.profiles),
        requiredCapabilities: stringArray(input.requiredCapabilities),
        recommendedCapabilities: stringArray(input.recommendedCapabilities),
        runtimeBackend: workspaceRuntimeBackend(input.runtimeBackend),
        cpuCount: text("cpuCount"),
        memory: text("memory"),
        pidsLimit: text("pidsLimit"),
        ...(input.kvm === undefined ? {} : { kvm: booleanValue(input.kvm) }),
        ...(input.gitUserName === undefined ? {} : { gitUserName: text("gitUserName") }),
        ...(input.gitUserEmail === undefined ? {} : { gitUserEmail: text("gitUserEmail") })
      }, plugins);
    case "workspace.list": return workspaceLifecycle.listWorkspaces(runner, lifecycle);
    case "workspace.show": return workspaceLifecycle.showWorkspace(runner, lifecycle, text("name"));
    case "workspace.setup": return workspaceLifecycle.setupWorkspace(runner, lifecycle, text("name"));
    case "workspace.update":
      return workspaceLifecycle.updateWorkspace(
        runner,
        lifecycle,
        text("name"),
        input.profiles === undefined ? undefined : stringArray(input.profiles)
      );
    case "workspace.resources":
      return workspaceLifecycle.updateWorkspaceResources(runner, lifecycle, text("name"), {
        ...(input.cpuCount === undefined ? {} : { cpuCount: text("cpuCount") }),
        ...(input.memory === undefined ? {} : { memory: text("memory") }),
        ...(input.pidsLimit === undefined ? {} : { pidsLimit: text("pidsLimit") })
      });
    case "workspace.start": return workspaceLifecycle.startWorkspace(runner, lifecycle, text("name"));
    case "workspace.restart": return workspaceLifecycle.restartWorkspace(runner, lifecycle, text("name"));
    case "workspace.exec": return {
      exitCode: await workspaceLifecycle.execWorkspace(runner, lifecycle, {
        name: text("name"),
        command: stringArray(input.command),
        interactive: input.interactive === true
      })
    };
    case "workspace.run": return {
      exitCode: await workspaceLifecycle.runWorkspace(runner, lifecycle, {
        name: text("name"),
        command: stringArray(input.command),
        interactive: input.interactive === true
      })
    };
    case "workspace.stop": await workspaceLifecycle.stopWorkspace(runner, lifecycle, text("name")); return {};
    case "workspace.discard":
      await workspaceLifecycle.discardWorkspace(
        runner,
        lifecycle,
        text("name"),
        input.keepVolume === true,
        plugins.workspaceDiscardHooks
      );
      return {};
    case "doctor": return runDoctor(runner, lifecycle.defaultWorkspaceBackend, lifecycle);
    case "plugin.list":
      return {
        plugins: plugins.plugins.filter((name) => !name.startsWith("builtin.")),
        controllerRoutes: plugins.controllerRoutes.map((route) => `${route.method} /api${route.path}`),
        adminRoutes: plugins.adminRoutes.map((route) => `${route.method} /v1${route.path}`)
      };
    default: throw new UserError(`unknown admin operation '${operation}'`);
  }
}

const MIRROR_REQUIRED_OPERATIONS = new Set([
  "workspace.create", "workspace.setup", "workspace.update", "workspace.start", "workspace.restart"
]);

export const STREAMABLE_OPERATIONS = new Set([
  "workspace.create", "workspace.setup", "workspace.update",
  "workspace.resources", "workspace.start", "workspace.restart", "workspace.stop",
  "workspace.discard", "workspace.exec", "workspace.run",
  "host.shutdown", "host.start", "doctor"
]);
