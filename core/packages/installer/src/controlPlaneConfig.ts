import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";
import { readPrivateControlPlaneFile } from "./controlPlaneSources.js";

const serviceKeys = ["image", "configFile", "readinessTokenFile", "publish"] as const;
const publishKeys = ["host", "port"] as const;
const imagePattern = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const deploymentPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type ControlPlanePublish = {
  readonly host: string;
  readonly port: number;
};

export type ControlPlaneServiceConfig = {
  readonly image: string;
  readonly configFile: string;
  readonly readinessTokenFile: string;
  readonly publish: ControlPlanePublish;
};

export type ControlPlaneConfig = {
  readonly schemaVersion: 1;
  readonly deploymentId: string;
  readonly nativeGit: ControlPlaneServiceConfig;
  readonly ordinaryCi: ControlPlaneServiceConfig;
};

export async function readControlPlaneConfig(
  target: string,
  localAddresses: readonly string[] = controlPlaneLocalAddresses()
): Promise<ControlPlaneConfig> {
  const file = await readPrivateControlPlaneFile(target, "control-plane installer config", 64 * 1024);
  let input: unknown;
  try {
    input = JSON.parse(file.bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ControlPlaneConfigError("control-plane installer config must contain valid JSON", { cause: error });
    }
    throw error;
  }
  return parseControlPlaneConfig(input, localAddresses);
}

export function parseControlPlaneConfig(
  input: unknown,
  localAddresses: readonly string[] = controlPlaneLocalAddresses()
): ControlPlaneConfig {
  const root = exactRecord(input, ["schemaVersion", "deploymentId", "nativeGit", "ordinaryCi"]);
  if (root.schemaVersion !== 1) invalid("schemaVersion must be 1");
  if (typeof root.deploymentId !== "string" || !deploymentPattern.test(root.deploymentId)) {
    invalid("deploymentId must be a safe lower-case identifier");
  }
  const addresses = new Set(localAddresses.map(normalizeAddress));
  const nativeGit = parseService(root.nativeGit, "nativeGit", addresses);
  const ordinaryCi = parseService(root.ordinaryCi, "ordinaryCi", addresses);
  if (nativeGit.publish.port === ordinaryCi.publish.port) invalid("published ports must be distinct");
  return { schemaVersion: 1, deploymentId: root.deploymentId, nativeGit, ordinaryCi };
}

export function controlPlaneLocalAddresses(): readonly string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.push(normalizeAddress(entry.address));
  }
  return addresses;
}

export class ControlPlaneConfigError extends Error {
  readonly name = "ControlPlaneConfigError";
}

function parseService(
  value: unknown,
  label: "nativeGit" | "ordinaryCi",
  localAddresses: ReadonlySet<string>
): ControlPlaneServiceConfig {
  const input = exactRecord(value, serviceKeys);
  if (typeof input.image !== "string" || !imagePattern.test(input.image)) {
    invalid(`${label}.image must be a registry reference pinned only by a complete sha256 digest`);
  }
  const configFile = absolutePath(input.configFile, `${label}.configFile`);
  const readinessTokenFile = absolutePath(input.readinessTokenFile, `${label}.readinessTokenFile`);
  if (configFile === readinessTokenFile) invalid(`${label} source paths must be distinct`);
  return {
    image: input.image,
    configFile,
    readinessTokenFile,
    publish: parsePublish(input.publish, label, localAddresses)
  };
}

function parsePublish(
  value: unknown,
  label: string,
  localAddresses: ReadonlySet<string>
): ControlPlanePublish {
  const input = exactRecord(value, publishKeys);
  if (typeof input.host !== "string" || isIP(input.host) === 0) invalid(`${label}.publish.host must be an IP address`);
  const host = normalizeAddress(input.host);
  if (host === "0.0.0.0" || host === "::") invalid(`${label}.publish.host must not be a wildcard address`);
  if (isMulticast(host)) invalid(`${label}.publish.host must not be multicast`);
  if (!localAddresses.has(host)) invalid(`${label}.publish.host must be assigned to a local interface`);
  if (typeof input.port !== "number" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    invalid(`${label}.publish.port must be an integer from 1 through 65535`);
  }
  return { host, port: input.port };
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return invalid("configuration objects must contain exactly the documented keys");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    return invalid("configuration objects must contain exactly the documented keys");
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    return invalid(`${label} must be an absolute path`);
  }
  return value;
}

function normalizeAddress(address: string): string {
  const scope = address.indexOf("%");
  return (scope === -1 ? address : address.slice(0, scope)).toLowerCase();
}

function isMulticast(address: string): boolean {
  if (isIP(address) === 4) {
    const first = Number(address.split(".")[0]);
    return first >= 224 && first <= 239;
  }
  return /^ff[0-9a-f]{2}:/i.test(address);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ControlPlaneConfigError(`invalid control-plane installer config: ${message}`);
}
