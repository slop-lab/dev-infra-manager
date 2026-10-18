import os from "node:os";
import path from "node:path";
import {
  acquireWorkspaceSource, buildWorkspaceImage, checkWorkspaceHost, ContainerWorkspaceRuntime, ProcessRunner, UserError,
  WorkspaceService, WorkspaceStore, type CreateWorkspaceInput
} from "@slop-lab/dim-core/workspace";
import { decodeHostRequest } from "./host-transport.js";

/** All filesystem/runtime work happens here, on the host selected by the client. */
export async function runHostRequest(encoded: string): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await dispatchHostRequest(encoded, abort.signal); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

async function dispatchHostRequest(encoded: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== "linux") throw new Error(`DIM runtime hosts require Linux; unsupported platform '${process.platform}'`);
  const request = decodeHostRequest(encoded);
  const input = request.input ?? {};
  const processRunner = new ProcessRunner();
  const runner = {
    run: (command: string, args: string[], options: import("@slop-lab/dim-core/workspace").RunOptions = {}) =>
      processRunner.run(command, args, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }),
    runStreaming: (command: string, args: string[], options: import("@slop-lab/dim-core/workspace").RunOptions = {}) =>
      processRunner.runStreaming(command, args, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal })
  };
  const service = new WorkspaceService(
    new WorkspaceStore(path.resolve(process.env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim"))),
    new ContainerWorkspaceRuntime(runner), (input) => acquireWorkspaceSource({ ...input, runner, signal })
  );
  let result: unknown;
  switch (request.operation) {
    case "image.build": {
      result = await buildWorkspaceImage(runner, {
        ...process.env, ...(input.image === undefined ? {} : { DIM_WORKSPACE_IMAGE: string(input.image, "image") })
      }, { signal, reportProgress: (stage) => process.stderr.write(`${stage}\n`) });
      break;
    }
    case "doctor": result = await checkWorkspaceHost(runner); break;
    case "list": result = await service.list(); break;
    case "show": result = await service.show(string(input.name, "name")); break;
    case "create": result = await service.create(createInput(input)); break;
    case "start": result = await service.start(string(input.name, "name")); break;
    case "stop": result = await service.stop(string(input.name, "name")); break;
    case "restart": result = await service.restart(string(input.name, "name")); break;
    case "recreate": result = await service.recreate(string(input.name, "name")); break;
    case "resources": {
      const resources = object(input.resources, "resources");
      result = await service.resources(string(input.name, "name"), {
        ...(resources.cpuCount === undefined ? {} : { cpuCount: string(resources.cpuCount, "cpuCount") }),
        ...(resources.memory === undefined ? {} : { memory: string(resources.memory, "memory") }),
        ...(resources.pidsLimit === undefined ? {} : { pidsLimit: string(resources.pidsLimit, "pidsLimit") })
      });
      break;
    }
    case "discard":
      await service.discard(string(input.name, "name")); result = { removed: true }; break;
    case "exec": {
      if (!Array.isArray(input.command) || input.command.some((v) => typeof v !== "string")) throw new UserError("command must be an argument array");
      process.exitCode = await service.exec(string(input.name, "name"), input.command as string[], {
        signal, stdin: process.stdin, ...(input.interactive === true ? { terminal: true } : {})
      });
      return;
    }
    default: throw new UserError(`unknown host operation '${request.operation}'`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function createInput(input: Record<string, unknown>): CreateWorkspaceInput {
  const source = object(input.source, "source");
  const resources = input.resources === undefined ? {} : object(input.resources, "resources");
  const git = input.git === undefined ? undefined : object(input.git, "git");
  return {
    name: string(input.name, "name"),
    source: { url: string(source.url, "source.url"), ...(source.ref === undefined ? {} : { ref: string(source.ref, "source.ref") }) },
    ...(input.image === undefined ? {} : { image: string(input.image, "image") }),
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
