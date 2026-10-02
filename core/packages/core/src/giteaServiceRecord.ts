import { isIP } from "node:net";
import { UserError } from "./errors.js";
import type { GiteaServiceRecord } from "./lifecycleTypes.js";

const REQUIRED_FIELDS = [
  "schemaVersion", "serviceId", "containerOwnershipId", "networkOwnershipId", "volumeOwnershipId",
  "phase", "containerName", "networkName", "volumeName", "image", "imageId", "resourcesEstablished",
  "port", "createdAt", "updatedAt"
] as const;
const OPTIONAL_FIELDS = ["networkId", "endpointAddress", "error"] as const;

export function parseGiteaServiceRecord(value: unknown): GiteaServiceRecord {
  if (!isRecord(value)) throw invalid("must be an object");
  if (value.schemaVersion !== 2) {
    throw new UserError(
      `Gitea service uses unsupported state schema ${String(value.schemaVersion)}; `
      + "expected 2. Stop DIM, remove only verified DIM-owned managed-Git resources and state, then recreate them"
    );
  }
  assertExactFields(value);
  const phase = parsePhase(value.phase);
  const endpointAddress = value.endpointAddress === undefined
    ? undefined
    : parseAddress(value.endpointAddress, "endpointAddress");
  const networkId = value.networkId === undefined ? undefined : parseDockerId(value.networkId, "networkId");
  if (typeof value.resourcesEstablished !== "boolean") throw invalid("resourcesEstablished");
  if (value.resourcesEstablished && networkId === undefined) throw invalid("established resources require networkId");
  if (phase === "ready" && endpointAddress === undefined) throw invalid("ready state requires endpointAddress");
  if (phase === "ready" && (!value.resourcesEstablished || networkId === undefined)) {
    throw invalid("ready state requires established resources");
  }
  if (!Number.isInteger(value.port) || typeof value.port !== "number" || value.port < 1 || value.port > 65_535) {
    throw invalid("port");
  }
  return {
    schemaVersion: 2,
    serviceId: parseIdentity(value.serviceId, "serviceId"),
    containerOwnershipId: parseIdentity(value.containerOwnershipId, "containerOwnershipId"),
    networkOwnershipId: parseIdentity(value.networkOwnershipId, "networkOwnershipId"),
    volumeOwnershipId: parseIdentity(value.volumeOwnershipId, "volumeOwnershipId"),
    phase,
    containerName: parseText(value.containerName, "containerName"),
    networkName: parseText(value.networkName, "networkName"),
    volumeName: parseText(value.volumeName, "volumeName"),
    image: parseText(value.image, "image"),
    imageId: parseImageId(value.imageId, "imageId"),
    ...(networkId === undefined ? {} : { networkId }),
    resourcesEstablished: value.resourcesEstablished,
    port: value.port,
    ...(endpointAddress === undefined ? {} : { endpointAddress }),
    createdAt: parseText(value.createdAt, "createdAt"),
    updatedAt: parseText(value.updatedAt, "updatedAt"),
    ...(value.error === undefined ? {} : { error: parseText(value.error, "error") })
  };
}

function assertExactFields(record: Readonly<Record<string, unknown>>): void {
  const allowed = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, field)) throw invalid(`missing field '${field}'`);
  }
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) throw invalid(`unknown field '${field}'`);
  }
}

function parsePhase(value: unknown): GiteaServiceRecord["phase"] {
  switch (value) {
    case "creating": case "ready": case "error": return value;
    default: throw invalid("phase");
  }
}

function parseIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid(field);
  return value;
}

function parseAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || isIP(value) === 0) throw invalid(field);
  return value;
}

function parseDockerId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid(field);
  return value;
}

function parseImageId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw invalid(field);
  return value;
}

function parseText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(field);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): UserError {
  return new UserError(`Gitea service state is invalid: ${detail}`);
}
