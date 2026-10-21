import net from "node:net";
import { UserError } from "@slop-lab/dim-host-core";
import type { DimPluginHost } from "@slop-lab/dim-host-core/controller";
import { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, type ExternalUrlIngressDriver } from "./plugin-api.js";

export function ingressDriver(host: DimPluginHost, name: string): ExternalUrlIngressDriver {
  const driver = host.extension<ExternalUrlIngressDriver>(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, name);
  if (!driver || typeof driver.configure !== "function" || typeof driver.runtime !== "function" || typeof driver.verify !== "function") {
    throw new UserError(`external URL ingress driver '${name}' is not installed; install and enable its DIM plugin first`);
  }
  return driver;
}

export function parseIngressCliArguments(driver: string, arguments_: readonly string[], allowed: ReadonlySet<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index]!;
    if (!option.startsWith("--") || !allowed.has(option.slice(2))) {
      throw new UserError(`unknown ${driver} ingress argument '${option}'`);
    }
    const value = arguments_[++index];
    if (value === undefined) throw new UserError(`${option} requires a value`);
    const key = option.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[key] = option === "--listen-port" && value === "auto"
      ? value
      : option === "--listen-port" || option === "--public-port"
        ? cliInteger(value, option)
        : value;
  }
  return result;
}

function cliInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UserError(`${option} requires an integer`);
  return parsed;
}

export async function availableTcpPort(host: string, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  for (;;) {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => resolve());
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!address || typeof address === "string") throw new UserError(`could not allocate a TCP port on ${host}`);
    if (!excluded.has(address.port)) return address.port;
  }
}

