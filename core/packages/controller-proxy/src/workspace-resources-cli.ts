#!/usr/bin/env node
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";
import {
  readWorkspaceResources,
  workspaceNprocCount,
  WorkspaceResourcesUnavailableError
} from "./workspace-resources.js";

const HELP = `Usage:
  dim-workspace-resources show
  dim-workspace-resources nproc
  dim-workspace-resources --help
`;

export async function runWorkspaceResourcesCli(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0] ?? "show";
  if (command === "--help" || command === "-h") {
    if (arguments_.length !== 1) throw new WorkspaceResourcesCliError("--help accepts no arguments");
    process.stdout.write(HELP);
    return;
  }
  if (arguments_.length > 1 || (command !== "show" && command !== "nproc")) {
    throw new WorkspaceResourcesCliError(HELP.trimEnd());
  }
  const socketPath = process.env.DIM_AGENT_CONTROLLER_SOCKET;
  if (!socketPath) {
    throw new WorkspaceResourcesCliError("DIM_AGENT_CONTROLLER_SOCKET is required");
  }
  const resources = await readWorkspaceResources(socketPath);
  if (command === "show") {
    process.stdout.write(`${JSON.stringify(resources)}\n`);
    return;
  }
  process.stdout.write(`${workspaceNprocCount(resources, availableParallelism())}\n`);
}

export class WorkspaceResourcesCliError extends Error {
  readonly name = "WorkspaceResourcesCliError";
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runWorkspaceResourcesCli(process.argv.slice(2)).catch((error: unknown) => {
    const detail = error instanceof WorkspaceResourcesUnavailableError
      || error instanceof WorkspaceResourcesCliError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`${detail}\n`);
    process.exitCode = 1;
  });
}
