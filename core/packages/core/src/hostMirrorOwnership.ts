import { randomBytes } from "node:crypto";
import { UserError } from "./errors.js";

export type HostMirrorResource =
  | "control-network"
  | "registry-cache-data"
  | "registry-cache"
  | "apt-cache-data"
  | "apt-cache";

export type HostMirrorOwnership = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly resourceIds: Readonly<Record<HostMirrorResource, string>>;
};

const resources = [
  "control-network",
  "registry-cache-data",
  "registry-cache",
  "apt-cache-data",
  "apt-cache"
] as const satisfies readonly HostMirrorResource[];

export function createHostMirrorOwnership(): HostMirrorOwnership {
  return {
    schemaVersion: 1,
    serviceId: identity(),
    resourceIds: {
      "control-network": identity(),
      "registry-cache-data": identity(),
      "registry-cache": identity(),
      "apt-cache-data": identity(),
      "apt-cache": identity()
    }
  };
}

export function parseHostMirrorOwnership(value: unknown): HostMirrorOwnership {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isIdentity(value.serviceId)
    || !isRecord(value.resourceIds) || Object.keys(value).sort().join("|") !== "resourceIds|schemaVersion|serviceId") {
    throw new UserError("host mirror ownership state is invalid");
  }
  const resourceIds = value.resourceIds;
  if (Object.keys(resourceIds).sort().join("|") !== [...resources].sort().join("|")
    || resources.some((resource) => !isIdentity(resourceIds[resource]))) {
    throw new UserError("host mirror ownership state is invalid");
  }
  const controlNetwork = resourceIds["control-network"];
  const registryCacheData = resourceIds["registry-cache-data"];
  const registryCache = resourceIds["registry-cache"];
  const aptCacheData = resourceIds["apt-cache-data"];
  const aptCache = resourceIds["apt-cache"];
  if (!isIdentity(controlNetwork) || !isIdentity(registryCacheData) || !isIdentity(registryCache)
    || !isIdentity(aptCacheData) || !isIdentity(aptCache)) {
    throw new UserError("host mirror ownership state is invalid");
  }
  return {
    schemaVersion: 1,
    serviceId: value.serviceId,
    resourceIds: {
      "control-network": controlNetwork,
      "registry-cache-data": registryCacheData,
      "registry-cache": registryCache,
      "apt-cache-data": aptCacheData,
      "apt-cache": aptCache
    }
  };
}

export function hostMirrorLabels(resource: HostMirrorResource, ownership: HostMirrorOwnership): readonly string[] {
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.service-id=${ownership.serviceId}`,
    `dim.resource=${resource}`,
    `dim.resource-id=${ownership.resourceIds[resource]}`
  ];
}

export function hostMirrorInspection(resource: HostMirrorResource, ownership: HostMirrorOwnership): string {
  return `true|dim|${ownership.serviceId}|${resource}|${ownership.resourceIds[resource]}`;
}

function identity(): string {
  return randomBytes(32).toString("base64url");
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
