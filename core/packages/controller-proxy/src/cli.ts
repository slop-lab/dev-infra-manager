#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createAgentControllerProxy, createControllerProxy } from "./index.js";
import { externalUrlProxy, type ExternalUrlTarget } from "./external-url.js";
import { ensureManagedProxy, managedProxyFingerprint } from "./managed-proxy.js";

async function main(arguments_: string[]): Promise<void> {
  if (arguments_[0] === "--config") {
    const config = arguments_[1];
    if (!config || arguments_.length !== 2) usage();
    await import(pathToFileURL(path.resolve(config)).href);
    return;
  }
  const ensure = arguments_[0] === "ensure";
  const presetIndex = ensure ? 1 : 0;
  const preset = arguments_[presetIndex];
  if (preset !== "external-url" && preset !== "agent") usage();
  let listen: string | undefined;
  let socketMode = 0o660;
  let directoryMode = 0o700;
  const ingresses: string[] = [];
  let bindContainersJson: string | undefined;
  let bindProtocol: "http" | "https" | "tcp" | undefined;
  let bindPort: number | undefined;
  const bindServiceSubdomains: Record<string, string> = {};
  let allowWorkspaceRestart = false;
  let allowWorkspaceResources = false;
  for (let index = presetIndex + 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--listen") listen = requiredValue(arguments_, ++index, argument);
    else if (argument === "--ingress") ingresses.push(requiredValue(arguments_, ++index, argument));
    else if (argument === "--bind-containers-json") bindContainersJson = requiredValue(arguments_, ++index, argument);
    else if (argument === "--bind-protocol") bindProtocol = protocol(requiredValue(arguments_, ++index, argument));
    else if (argument === "--bind-port") bindPort = port(requiredValue(arguments_, ++index, argument));
    else if (argument === "--bind-service-subdomain") {
      const [service, subdomain, extra] = requiredValue(arguments_, ++index, argument).split("=");
      if (service === undefined || subdomain === undefined || extra !== undefined || service in bindServiceSubdomains) usage();
      bindServiceSubdomains[service] = subdomain;
    }
    else if (argument === "--allow-workspace-restart") allowWorkspaceRestart = true;
    else if (argument === "--allow-workspace-resources") allowWorkspaceResources = true;
    else if (argument === "--socket-mode") socketMode = mode(requiredValue(arguments_, ++index, argument));
    else if (argument === "--directory-mode") directoryMode = mode(requiredValue(arguments_, ++index, argument));
    else usage();
  }
  if (!listen) usage();
  const bindOptions = [bindContainersJson, bindProtocol, bindPort];
  const hasBoundTarget = bindOptions.every((value) => value !== undefined);
  if ((preset === "external-url" && ingresses.length === 0)
    || (preset === "agent" && !allowWorkspaceRestart && !allowWorkspaceResources)
    || (preset === "external-url" && allowWorkspaceRestart)
    || (preset === "agent" && ingresses.length > 0)
    || (bindOptions.some((value) => value !== undefined) && !hasBoundTarget)
    || (Object.keys(bindServiceSubdomains).length > 0 && !hasBoundTarget)
    || (preset === "agent" && hasBoundTarget)
    || (ensure && preset !== "external-url")) usage();
  let boundTarget: ExternalUrlTarget | undefined;
  if (bindContainersJson !== undefined && bindProtocol !== undefined && bindPort !== undefined) {
    boundTarget = { containers: containers(bindContainersJson), protocol: bindProtocol, port: bindPort };
  }
  if (ensure) {
    const sourceSocket = process.env.DIM_CONTROLLER_SOCKET;
    const token = process.env.DIM_CONTROLLER_TOKEN;
    if (!sourceSocket || !token) throw new Error("DIM_CONTROLLER_SOCKET and DIM_CONTROLLER_TOKEN are required");
    const cliPath = fileURLToPath(import.meta.url);
    const childArguments = arguments_.slice(1);
    const result = await ensureManagedProxy({
      listen,
      fingerprint: managedProxyFingerprint(JSON.stringify({
        preset,
        listen: path.resolve(listen),
        socketMode,
        directoryMode,
        ingresses,
        boundTarget,
        bindServiceSubdomains,
        sourceSocket,
        token
      })),
      command: {
        executable: process.execPath,
        arguments: [cliPath, ...childArguments],
        identityMarker: cliPath,
        environment: process.env
      }
    });
    console.log(`DIM controller proxy ${result.action} on ${path.resolve(listen)} (PID ${result.pid})`);
    return;
  }
  const proxy = preset === "external-url"
    ? createControllerProxy({
      listen,
      socketMode,
      directoryMode,
      capabilities: [externalUrlProxy({
        allowedIngresses: ingresses,
        ...(boundTarget === undefined ? {} : { boundTarget }),
        ...(Object.keys(bindServiceSubdomains).length === 0
          ? {}
          : { boundServiceSubdomains: bindServiceSubdomains })
      })]
    })
    : createAgentControllerProxy({
      listen,
      socketMode,
      directoryMode,
      routes: [
        ...(allowWorkspaceRestart ? [{ method: "POST", path: "/api/workspace/restart" }] : []),
        ...(allowWorkspaceResources ? [{ method: "GET", path: "/api/workspace/resources" }] : [])
      ]
    });
  await proxy.listen();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void proxy.close().finally(() => process.exit(0)));
  }
  console.log(`DIM controller proxy listening on ${proxy.socketPath}`);
}

function containers(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 2
    || !parsed.every((container) => typeof container === "string" && container.length > 0)) {
    throw new Error("--bind-containers-json requires an array of zero, one, or two non-empty strings");
  }
  return parsed;
}

function protocol(value: string): "http" | "https" | "tcp" {
  if (value !== "http" && value !== "https" && value !== "tcp") {
    throw new Error("--bind-protocol requires http, https, or tcp");
  }
  return value;
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("--bind-port requires an integer between 1 and 65535");
  }
  return parsed;
}

function mode(value: string): number {
  if (!/^[0-7]{3,4}$/.test(value)) throw new Error(`invalid Unix mode '${value}'`);
  return Number.parseInt(value, 8);
}

function requiredValue(arguments_: string[], index: number, option: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function usage(): never {
  throw new Error(
    "usage: dim-controller-proxy external-url --listen SOCKET --ingress NAME [--ingress NAME ...]\n"
    + "       [--bind-containers-json JSON --bind-protocol http|https|tcp --bind-port PORT]\n"
    + "       [--bind-service-subdomain SERVICE=SUBDOMAIN ...]\n"
    + "       [--directory-mode MODE] [--socket-mode MODE]\n"
    + "   or: dim-controller-proxy ensure external-url --listen SOCKET --ingress NAME [--ingress NAME ...]\n"
    + "       [--bind-containers-json JSON --bind-protocol http|https|tcp --bind-port PORT]\n"
    + "       [--bind-service-subdomain SERVICE=SUBDOMAIN ...]\n"
    + "       [--directory-mode MODE] [--socket-mode MODE]\n"
    + "   or: dim-controller-proxy agent --listen SOCKET [--allow-workspace-restart]\n"
    + "       [--allow-workspace-resources]\n"
    + "       [--directory-mode MODE] [--socket-mode MODE]\n"
    + "   or: dim-controller-proxy --config FILE.mjs"
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
