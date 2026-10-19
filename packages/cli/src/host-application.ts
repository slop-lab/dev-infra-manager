import os from "node:os";
import path from "node:path";
import {
  acquireWorkspaceSource, buildWorkspaceImage, checkWorkspaceHost, ProcessRunner, UserError,
  WorkspaceService, WorkspaceStore
} from "@slop-lab/dim-host-core/workspace";
import { createWorkspaceOnHost, ensureWorkspaceIntegration, type WorkspaceHostCreateInput } from "./workspace-composition.js";
import { decodeHostRequest } from "./host-transport.js";
import { composeWorkspaceRuntime, loadHostPlugins, resolveHostExecutionRouting } from "./host-plugins.js";
import { ensureWorkspaceAgent } from "./workspace-agent.js";
import { installRequiredPlugins, workspaceRequirements } from "./workspace-requirements.js";

/** All filesystem/runtime work happens here, on the host selected by the client. */
export async function runHostRequest(encoded: string): Promise<void> {
  const request = decodeHostRequest(encoded);
  if (request.operation === "controlPlane.cli" || request.operation === "controller.cli") {
    const args = request.input?.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new UserError("control-plane command must be an argument array");
    }
    // Operator commands own their signal/cleanup policy.
    if (request.operation === "controller.cli") {
      const { runControllerApplication } = await import("./controller-application.js");
      await runControllerApplication(args as string[]);
    } else {
      const { runControlPlaneApplication } = await import("./control-plane-application.js");
      await runControlPlaneApplication(args as string[]);
    }
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("SIGHUP", stop);
  try { await dispatchHostRequest(encoded, abort.signal); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop); }
}

async function dispatchHostRequest(encoded: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== "linux") throw new Error(`DIM runtime hosts require Linux; unsupported platform '${process.platform}'`);
  const request = decodeHostRequest(encoded);
  const input = request.input ?? {};
  const expectedId = input.expectedId === undefined ? undefined : string(input.expectedId, "expectedId");
  const processRunner = new ProcessRunner();
  const requirements = workspaceRequirements(input.expectedSourceCommit === undefined ? undefined : string(input.expectedSourceCommit, "expectedSourceCommit"));
  const runner = {
    run: (command: string, args: string[], options: import("@slop-lab/dim-host-core/workspace").RunOptions = {}) =>
      processRunner.run(command, args, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }),
    runStreaming: (command: string, args: string[], options: import("@slop-lab/dim-host-core/workspace").RunOptions = {}) =>
      processRunner.runStreaming(command, args, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal })
  };
  const store = new WorkspaceStore(path.resolve(process.env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim")), { signal });
  const composition = composeWorkspaceRuntime({ runner, cleanupRunner: processRunner, stateRoot: store.root });
  const cleanupWorkspace = async (name: string, workspaceId?: string) => {
    const cleanupSignal = AbortSignal.timeout(30_000);
    const cleanupRunner = {
      run: (command: string, args: string[], options: import("@slop-lab/dim-host-core/workspace").RunOptions = {}) =>
        processRunner.run(command, args, { ...options, signal: options.signal ? AbortSignal.any([cleanupSignal, options.signal]) : cleanupSignal }),
      runStreaming: (command: string, args: string[], options: import("@slop-lab/dim-host-core/workspace").RunOptions = {}) =>
        processRunner.runStreaming(command, args, { ...options, signal: options.signal ? AbortSignal.any([cleanupSignal, options.signal]) : cleanupSignal })
    };
    const cleanupRuntime = composeWorkspaceRuntime({ runner: cleanupRunner, cleanupRunner: processRunner, stateRoot: store.root });
    const cleanup = new WorkspaceService(new WorkspaceStore(store.root, { signal: cleanupSignal }), cleanupRuntime.runtime,
      async () => { throw new UserError("cleanup cannot acquire source"); });
    await cleanup.discard(name, workspaceId);
  };
  const executionRouting = async () => resolveHostExecutionRouting(await loadHostPlugins(), { runner, cleanupRunner: processRunner, stateRoot: store.root, signal });
  const context = { executionRouting, store, runner, cleanupRunner: processRunner, signal, runtime: composition.runtime, cleanupWorkspace,
    validateCheckout: requirements.validateCheckout,
    hostGateway: (workspace: import("@slop-lab/dim-host-core/workspace").WorkspaceRecord) => {
      if (!composition.runtime.hostGateway) throw new UserError(`runtime '${workspace.runtime}' does not provide a private host gateway`);
      return composition.runtime.hostGateway(workspace);
    } };
  const service = new WorkspaceService(
    store, composition.runtime,
    async (input) => {
      const source = await acquireWorkspaceSource({ ...input, runner, signal });
      await requirements.validateCheckout(input.destination, source);
      return source;
    }
  );
  const agentContext = { ...context, stateRoot: store.root, service };
  let result: unknown;
  switch (request.operation) {
    case "plugins.installRequired": await installRequiredPlugins(input.plugins, runner, signal); result = { installed: true }; break;
    case "plugins": result = (await loadHostPlugins()).map(({ name, commands, runtime }) => ({ name, commands: commands ?? [], ...(runtime ? { runtime: runtime.name } : {}) })); break;
    case "plugin.cli": {
      if (!Array.isArray(input.args) || !input.args.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0"))) throw new UserError("plugin command must be an argument array");
      const args = input.args as string[];
      const plugin = (await loadHostPlugins()).find((plugin) => plugin.commands?.some(({ name }) => name === args[0]));
      if (!plugin?.run) throw new UserError(`unknown command '${args[0] ?? ""}'; use 'dim plugins' to inspect installed host commands`);
      await plugin.run(args, { ...context, stateRoot: store.root, service }); return;
    }
    case "image.build": {
      result = await buildWorkspaceImage(runner, {
        ...process.env, ...(input.image === undefined ? {} : { DIM_WORKSPACE_IMAGE: string(input.image, "image") })
      }, { signal, reportProgress: (stage) => process.stderr.write(`${stage}\n`) });
      break;
    }
    case "doctor": result = await checkWorkspaceHost(runner); break;
    case "list": result = await service.list(); break;
    case "show": result = await service.show(string(input.name, "name")); break;
    case "create": {
      const creation = createInput(input);
      if (creation.runtime !== undefined && creation.runtime !== "container") {
        const defaultImage = await composition.defaultImage(creation.runtime);
        if (!creation.image && !defaultImage) throw new UserError(`runtime '${creation.runtime}' requires an explicit --image`);
        if (!creation.image && defaultImage) creation.image = defaultImage;
      }
      let record;
      try { record = await createWorkspaceOnHost(creation, service, context); }
      catch (error) {
        if (!requirements.missing) throw error;
        result = requirements.missing; break;
      }
      await ensureWorkspaceAgent(record, agentContext);
      result = record; break;
    }
    case "start": {
      const record = await service.start(string(input.name, "name"), expectedId);
      await ensureWorkspaceIntegration(record, context);
      await ensureWorkspaceAgent(record, agentContext);
      result = record; break;
    }
    case "stop": result = await service.stop(string(input.name, "name"), expectedId); break;
    case "restart": {
      const record = await service.restart(string(input.name, "name"), expectedId);
      await ensureWorkspaceIntegration(record, context);
      await ensureWorkspaceAgent(record, agentContext);
      result = record; break;
    }
    case "recreate": {
      const record = await service.recreate(string(input.name, "name"), expectedId);
      await ensureWorkspaceIntegration(record, context);
      await ensureWorkspaceAgent(record, agentContext);
      result = record; break;
    }
    case "resources": {
      const resources = object(input.resources, "resources");
      const updated = await service.resources(string(input.name, "name"), {
        ...(resources.cpuCount === undefined ? {} : { cpuCount: string(resources.cpuCount, "cpuCount") }),
        ...(resources.memory === undefined ? {} : { memory: string(resources.memory, "memory") }),
        ...(resources.pidsLimit === undefined ? {} : { pidsLimit: string(resources.pidsLimit, "pidsLimit") })
      }, expectedId);
      if (updated.recreated && updated.workspace.phase === "running") {
        await ensureWorkspaceIntegration(updated.workspace, context);
        await ensureWorkspaceAgent(updated.workspace, agentContext);
      }
      result = updated;
      break;
    }
    case "discard":
      await service.discard(string(input.name, "name"), expectedId); result = { removed: true }; break;
    case "exec": {
      if (!Array.isArray(input.command) || input.command.some((v) => typeof v !== "string")) throw new UserError("command must be an argument array");
      const name = string(input.name, "name");
      await ensureWorkspaceIntegration(await store.read(name), context);
      await ensureWorkspaceAgent(await store.read(name), agentContext);
      process.exitCode = await service.exec(name, input.command as string[], {
        signal, stdin: process.stdin, ...(input.interactive === true ? { terminal: true } : {})
      });
      return;
    }
    case "connect": {
      if (typeof input.port !== "number") throw new UserError("port must be an integer between 1 and 65535");
      process.exitCode = await service.connect(string(input.name, "name"), input.port, {
        signal, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
        ...(input.workspaceId === undefined ? {} : { workspaceId: string(input.workspaceId, "workspaceId") })
      });
      return;
    }
    default: throw new UserError(`unknown host operation '${request.operation}'`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function createInput(input: Record<string, unknown>): WorkspaceHostCreateInput {
  const source = object(input.source, "source");
  const resources = input.resources === undefined ? {} : object(input.resources, "resources");
  const git = input.git === undefined ? undefined : object(input.git, "git");
  if (input.repositories !== undefined && (!Array.isArray(input.repositories) || input.repositories.length === 0
    || input.repositories.some((id: unknown) => typeof id !== "string"))) throw new UserError("repositories must be a nonempty array of repository IDs");
  return {
    name: string(input.name, "name"),
    ...(input.repositories === undefined ? {} : { repositories: input.repositories as string[] }),
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: string(input.workingDirectory, "workingDirectory") }),
    source: { url: string(source.url, "source.url"), ...(source.ref === undefined ? {} : { ref: string(source.ref, "source.ref") }) },
    ...(input.image === undefined ? {} : { image: string(input.image, "image") }),
    ...(input.runtime === undefined ? {} : { runtime: string(input.runtime, "runtime") }),
    resources: {
      ...(resources.cpuCount === undefined ? {} : { cpuCount: string(resources.cpuCount, "cpuCount") }),
      ...(resources.memory === undefined ? {} : { memory: string(resources.memory, "memory") }),
      ...(resources.pidsLimit === undefined ? {} : { pidsLimit: string(resources.pidsLimit, "pidsLimit") })
    },
    ...(git === undefined ? {} : { git: { name: string(git.name, "git.name"), email: string(git.email, "git.email") } })
  };
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new UserError(`${name} must be a nonempty string`);
  return value;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
