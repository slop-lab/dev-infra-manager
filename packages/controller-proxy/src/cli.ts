#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createControllerProxy } from "./index.js";
import { externalUrlProxy } from "./external-url.js";

async function main(arguments_: string[]): Promise<void> {
  if (arguments_[0] === "--config") {
    const config = arguments_[1];
    if (!config || arguments_.length !== 2) usage();
    await import(pathToFileURL(path.resolve(config)).href);
    return;
  }
  if (arguments_[0] !== "external-url") usage();
  let listen: string | undefined;
  let socketMode = 0o660;
  let directoryMode = 0o700;
  const ingresses: string[] = [];
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--listen") listen = requiredValue(arguments_, ++index, argument);
    else if (argument === "--ingress") ingresses.push(requiredValue(arguments_, ++index, argument));
    else if (argument === "--socket-mode") socketMode = mode(requiredValue(arguments_, ++index, argument));
    else if (argument === "--directory-mode") directoryMode = mode(requiredValue(arguments_, ++index, argument));
    else usage();
  }
  if (!listen || ingresses.length === 0) usage();
  const proxy = createControllerProxy({
    listen,
    socketMode,
    directoryMode,
    capabilities: [externalUrlProxy({ allowedIngresses: ingresses })]
  });
  await proxy.listen();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void proxy.close().finally(() => process.exit(0)));
  }
  console.log(`DIM controller proxy listening on ${proxy.socketPath}`);
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
    + "       [--directory-mode MODE] [--socket-mode MODE]\n"
    + "   or: dim-controller-proxy --config FILE.mjs"
  );
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
