#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { workspaceServiceSubdomain } from "@slop-lab/dim-contracts-external-url";
import { exposeDevelopmentService } from "./development-service-expose.js";
import {
  ensureDevelopmentServiceGateway,
  runDevelopmentServiceGateway
} from "./development-service-lifecycle.js";
import { requestDevelopmentUrl } from "./development-service-request.js";
import {
  DEVELOPMENT_SERVICE_GATEWAY_PORT,
  developmentServiceStateDirectory,
  isPort
} from "./development-service-state.js";

const HELP = `Usage:
  dim-development-service gateway-port
  dim-development-service workspace-subdomain --workspace NAME --service NAME
  dim-development-service expose --name NAME --port PORT --ingress NAME [--require-scheme https]
  dim-development-service request-url --ingress NAME --container NAME [--container NAME] --port PORT
  dim-development-service --help
`;

type ExposeArguments = {
  readonly name: string;
  readonly targetPort: number;
  readonly ingress: string;
  readonly requiredScheme?: "http" | "https";
};

type RequestUrlArguments = {
  readonly ingress: string;
  readonly containers: readonly string[];
  readonly targetPort: number;
};

export async function runDevelopmentServiceCli(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0];
  if (command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "gateway-port") {
    if (arguments_.length !== 1) throw new DevelopmentServiceCliError("gateway-port accepts no options");
    process.stdout.write(`${DEVELOPMENT_SERVICE_GATEWAY_PORT}\n`);
    return;
  }
  if (command === "workspace-subdomain") {
    if (arguments_.length !== 5 || arguments_[1] !== "--workspace" || arguments_[3] !== "--service"
      || arguments_[2] === undefined || arguments_[4] === undefined) {
      throw new DevelopmentServiceCliError("workspace-subdomain requires --workspace NAME --service NAME");
    }
    process.stdout.write(`${workspaceServiceSubdomain(arguments_[2], arguments_[4])}\n`);
    return;
  }
  if (command === "__gateway") {
    const stateDirectory = internalStateDirectory(arguments_.slice(1));
    await runDevelopmentServiceGateway(stateDirectory);
    return;
  }
  if (command === "request-url") {
    const options = parseRequestUrlArguments(arguments_.slice(1));
    const controller = workspaceController();
    const result = await requestDevelopmentUrl({ ...options, ...controller });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command !== "expose") throw new DevelopmentServiceCliError(HELP.trimEnd());
  const options = parseExposeArguments(arguments_.slice(1));
  const developmentUrlSocket = process.env.DIM_DEVELOPMENT_URL_SOCKET;
  if (!developmentUrlSocket) {
    throw new DevelopmentServiceCliError("DIM_DEVELOPMENT_URL_SOCKET is required");
  }
  const stateDirectory = developmentServiceStateDirectory();
  const controlSocket = await ensureDevelopmentServiceGateway(
    stateDirectory,
    fileURLToPath(import.meta.url)
  );
  const url = await exposeDevelopmentService({
    ...options,
    developmentUrlSocket,
    gatewayControlSocket: controlSocket
  });
  process.stdout.write(`${url}\n`);
}

function workspaceController(): { readonly controllerSocket: string; readonly controllerToken: string } {
  const controllerSocket = process.env.DIM_CONTROLLER_SOCKET;
  const controllerToken = process.env.DIM_CONTROLLER_TOKEN;
  if (controllerSocket && controllerToken) return { controllerSocket, controllerToken };
  if (controllerSocket || controllerToken) {
    throw new DevelopmentServiceCliError(
      "DIM_CONTROLLER_SOCKET and DIM_CONTROLLER_TOKEN must be set together"
    );
  }
  const agentSocket = process.env.DIM_AGENT_CONTROLLER_SOCKET;
  const agentToken = process.env.DIM_AGENT_CONTROLLER_TOKEN;
  if (agentSocket && agentToken) return { controllerSocket: agentSocket, controllerToken: agentToken };
  if (agentSocket || agentToken) {
    throw new DevelopmentServiceCliError(
      "DIM_AGENT_CONTROLLER_SOCKET and DIM_AGENT_CONTROLLER_TOKEN must be set together"
    );
  }
  throw new DevelopmentServiceCliError("workspace controller socket and token are required");
}

function parseRequestUrlArguments(arguments_: readonly string[]): RequestUrlArguments {
  let ingress: string | undefined;
  let targetPort: number | undefined;
  const containers: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new DevelopmentServiceCliError(`${argument ?? "option"} requires a value`);
    }
    if (argument !== "--container" && argument !== undefined && seen.has(argument)) {
      throw new DevelopmentServiceCliError(`duplicate option '${argument}'`);
    }
    if (argument !== undefined) seen.add(argument);
    if (argument === "--ingress") ingress = value;
    else if (argument === "--container") containers.push(value);
    else if (argument === "--port") targetPort = parsePort(value);
    else throw new DevelopmentServiceCliError(`unknown option '${argument ?? ""}'`);
    index += 1;
  }
  if (ingress === undefined || targetPort === undefined || containers.length === 0) {
    throw new DevelopmentServiceCliError("request-url requires --ingress, --container, and --port");
  }
  if (containers.length > 2) {
    throw new DevelopmentServiceCliError("request-url accepts at most two --container options");
  }
  return { ingress, containers, targetPort };
}

function parseExposeArguments(arguments_: readonly string[]): ExposeArguments {
  let name: string | undefined;
  let targetPort: number | undefined;
  let ingress: string | undefined;
  let requiredScheme: "http" | "https" | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new DevelopmentServiceCliError(`${argument ?? "option"} requires a value`);
    }
    if (argument !== undefined && seen.has(argument)) {
      throw new DevelopmentServiceCliError(`duplicate option '${argument}'`);
    }
    if (argument !== undefined) seen.add(argument);
    if (argument === "--name") name = value;
    else if (argument === "--port") targetPort = parsePort(value);
    else if (argument === "--ingress") ingress = value;
    else if (argument === "--require-scheme") requiredScheme = parseScheme(value);
    else throw new DevelopmentServiceCliError(`unknown option '${argument ?? ""}'`);
    index += 1;
  }
  if (name === undefined || targetPort === undefined || ingress === undefined) {
    throw new DevelopmentServiceCliError("expose requires --name, --port, and --ingress");
  }
  return {
    name,
    targetPort,
    ingress,
    ...(requiredScheme === undefined ? {} : { requiredScheme })
  };
}

function internalStateDirectory(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--state-directory" || arguments_[1] === undefined) {
    throw new DevelopmentServiceCliError("invalid internal gateway invocation");
  }
  const expected = developmentServiceStateDirectory();
  if (arguments_[1] !== expected) throw new DevelopmentServiceCliError("gateway state directory must be under HOME");
  return expected;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!isPort(parsed)) throw new DevelopmentServiceCliError("--port requires an integer between 1 and 65535");
  return parsed;
}

function parseScheme(value: string): "https" {
  if (value !== "https") {
    throw new DevelopmentServiceCliError("--require-scheme requires https");
  }
  return value;
}

export class DevelopmentServiceCliError extends Error {
  readonly name = "DevelopmentServiceCliError";
}

runDevelopmentServiceCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
