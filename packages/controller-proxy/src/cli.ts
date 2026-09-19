#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createAgentControllerProxy, createControllerProxy } from "./index.js";
import { externalUrlProxy, type ExternalUrlTarget } from "./external-url.js";

async function main(arguments_: string[]): Promise<void> {
  if (arguments_[0] === "--config") {
    const config = arguments_[1];
    if (!config || arguments_.length !== 2) usage();
    await import(pathToFileURL(path.resolve(config)).href);
    return;
  }
  const preset = arguments_[0];
  if (preset !== "external-url" && preset !== "agent") usage();
  let listen: string | undefined;
  let socketMode = 0o660;
  let directoryMode = 0o700;
  const ingresses: string[] = [];
  let targetContainersJson: string | undefined;
  let targetProtocol: "http" | "https" | undefined;
  let targetPort: number | undefined;
  let allowWorkspaceRestart = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--listen") listen = requiredValue(arguments_, ++index, argument);
    else if (argument === "--ingress") ingresses.push(requiredValue(arguments_, ++index, argument));
    else if (argument === "--target-containers-json") targetContainersJson = requiredValue(arguments_, ++index, argument);
    else if (argument === "--target-protocol") targetProtocol = protocol(requiredValue(arguments_, ++index, argument));
    else if (argument === "--target-port") targetPort = port(requiredValue(arguments_, ++index, argument));
    else if (argument === "--allow-workspace-restart") allowWorkspaceRestart = true;
    else if (argument === "--socket-mode") socketMode = mode(requiredValue(arguments_, ++index, argument));
    else if (argument === "--directory-mode") directoryMode = mode(requiredValue(arguments_, ++index, argument));
    else usage();
  }
  if (!listen) usage();
  const targetOptions = [targetContainersJson, targetProtocol, targetPort];
  const hasTarget = targetOptions.every((value) => value !== undefined);
  if ((preset === "external-url" && ingresses.length === 0)
    || (preset === "agent" && !allowWorkspaceRestart)
    || (preset === "external-url" && allowWorkspaceRestart)
    || (preset === "agent" && ingresses.length > 0)
    || (targetOptions.some((value) => value !== undefined) && !hasTarget)
    || (preset === "agent" && hasTarget)) usage();
  let allowedTargets: ExternalUrlTarget[] | undefined;
  if (targetContainersJson !== undefined && targetProtocol !== undefined && targetPort !== undefined) {
    allowedTargets = [{ containers: containers(targetContainersJson), protocol: targetProtocol, port: targetPort }];
  }
  const proxy = preset === "external-url"
    ? createControllerProxy({
      listen,
      socketMode,
      directoryMode,
      capabilities: [externalUrlProxy({
        allowedIngresses: ingresses,
        ...(allowedTargets === undefined ? {} : { allowedTargets })
      })]
    })
    : createAgentControllerProxy({
      listen,
      socketMode,
      directoryMode,
      routes: allowWorkspaceRestart
        ? [{ method: "POST", path: "/api/workspace/restart" }]
        : []
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
    throw new Error("--target-containers-json requires an array of zero, one, or two non-empty strings");
  }
  return parsed;
}

function protocol(value: string): "http" | "https" {
  if (value !== "http" && value !== "https") throw new Error("--target-protocol requires http or https");
  return value;
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("--target-port requires an integer between 1 and 65535");
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
    + "       [--target-containers-json JSON --target-protocol http|https --target-port PORT]\n"
    + "       [--directory-mode MODE] [--socket-mode MODE]\n"
    + "   or: dim-controller-proxy agent --listen SOCKET --allow-workspace-restart\n"
    + "       [--directory-mode MODE] [--socket-mode MODE]\n"
    + "   or: dim-controller-proxy --config FILE.mjs"
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
