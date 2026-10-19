import { randomBytes } from "node:crypto";
import { UserError } from "@slop-lab/dim-host-core";

export type HostMirrorResource = string;
export interface HostMirrorOwnership {
  readonly schemaVersion: 2;
  readonly serviceId: string;
  readonly resourceIds: Readonly<Record<string, string>>;
}

export function createHostMirrorOwnership(resources: readonly string[] = ["network"]): HostMirrorOwnership {
  return extendHostMirrorOwnership({ schemaVersion: 2, serviceId: identity(), resourceIds: {} }, resources);
}

export function extendHostMirrorOwnership(ownership: HostMirrorOwnership, resources: readonly string[]): HostMirrorOwnership {
  const resourceIds = { ...ownership.resourceIds };
  for (const resource of resources) {
    if (!isResource(resource)) throw new UserError("invalid host cache resource name");
    resourceIds[resource] ??= identity();
  }
  return { ...ownership, resourceIds };
}

export function parseHostMirrorOwnership(value: unknown): HostMirrorOwnership {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isIdentity(value.serviceId)
    || !isRecord(value.resourceIds) || Object.keys(value).sort().join("|") !== "resourceIds|schemaVersion|serviceId"
    || !isIdentity(value.resourceIds.network)) throw new UserError("host mirror ownership state is invalid");
  const resourceIds: Record<string, string> = {};
  for (const [resource, id] of Object.entries(value.resourceIds)) {
    if (!isResource(resource) || !isIdentity(id)) throw new UserError("host mirror ownership state is invalid");
    resourceIds[resource] = id;
  }
  return { schemaVersion: 2, serviceId: value.serviceId, resourceIds };
}

export function hostMirrorLabels(resource: HostMirrorResource, ownership: HostMirrorOwnership): readonly string[] {
  const id = ownership.resourceIds[resource];
  if (!id) throw new UserError(`host cache resource '${resource}' has no ownership identity`);
  return ["dim.managed=true", "dim.owner=dim", `dim.service-id=${ownership.serviceId}`, `dim.resource=${resource}`, `dim.resource-id=${id}`];
}

export function hostMirrorInspection(resource: HostMirrorResource, ownership: HostMirrorOwnership): string {
  const id = ownership.resourceIds[resource];
  if (!id) throw new UserError(`host cache resource '${resource}' has no ownership identity`);
  return `true|dim|${ownership.serviceId}|${resource}|${id}`;
}

function identity(): string { return randomBytes(32).toString("base64url"); }
function isResource(value: string): boolean { return /^(?:network|(?:cache|data):[a-z][a-z0-9-]{0,31})$/.test(value); }
function isIdentity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
