import { Buffer } from "node:buffer";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import {
  validateNativeOrdinaryAuthorityConfig,
  type NativeOrdinaryAuthorityConfig,
  type NativeOrdinaryCredential
} from "./nativeOrdinaryAuthorityConfig.js";

const topLevelKeys = [
  "schemaVersion", "serviceId", "database", "admissionLeaseMilliseconds", "claimLeaseMilliseconds",
  "nativeGit", "credentials", "hosts"
] as const;
const nativeGitKeys = ["endpoint", "serviceId", "identity", "attemptIssuer", "resultReporter"] as const;
const credentialKeys = ["username", "password"] as const;
const roleKeys = ["webhook", "registrar", "query"] as const;
const hostKeys = ["hostId", "hostToken", "capacities"] as const;
const capacityKeys = ["capacity", "runnerBaseImage", "bounds"] as const;
const boundKeys = ["cpu", "memoryBytes", "pids", "wallClockSeconds", "outputBytes"] as const;

export function parseNativeOrdinaryBundleConfig(input: unknown): NativeOrdinaryAuthorityConfig {
  const root = exactRecord(input, topLevelKeys);
  if (root.schemaVersion !== 3) invalid();
  if (root.serviceId !== "ordinary-main") {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle service ID must be ordinary-main");
  }
  if (root.database !== "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3") {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle database path is invalid");
  }
  const nativeGit = parseNativeGit(root.nativeGit);
  const roles = parseRoles(root.credentials);
  const hosts = array(root.hosts).map(parseHost);
  const config: NativeOrdinaryAuthorityConfig = {
    schemaVersion: 3,
    serviceId: "ordinary-main",
    database: "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3",
    admissionLeaseMilliseconds: positiveSafeInteger(root.admissionLeaseMilliseconds),
    claimLeaseMilliseconds: positiveSafeInteger(root.claimLeaseMilliseconds),
    nativeGit,
    credentials: roles,
    hosts
  };
  assertUniqueHosts(hosts);
  assertDistinctAuthority(config);
  validateNativeOrdinaryAuthorityConfig(config);
  return config;
}

export class NativeOrdinaryBundleConfigError extends Error {
  readonly name = "NativeOrdinaryBundleConfigError";
}

function parseNativeGit(value: unknown): NativeOrdinaryAuthorityConfig["nativeGit"] {
  const input = exactRecord(value, nativeGitKeys);
  if (input.endpoint !== "http://native-git:8080" || input.serviceId !== "native-main") {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle native Git identity is invalid");
  }
  return {
    endpoint: "http://native-git:8080",
    serviceId: "native-main",
    identity: parseCredential(input.identity),
    attemptIssuer: parseCredential(input.attemptIssuer),
    resultReporter: parseCredential(input.resultReporter)
  };
}

function parseRoles(value: unknown): NativeOrdinaryAuthorityConfig["credentials"] {
  const input = exactRecord(value, roleKeys);
  return {
    webhook: parseCredential(input.webhook),
    registrar: parseCredential(input.registrar),
    query: parseCredential(input.query)
  };
}

function parseCredential(value: unknown): NativeOrdinaryCredential {
  const input = exactRecord(value, credentialKeys);
  if (typeof input.username !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(input.username)) {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle credential username is invalid");
  }
  if (!isBundleToken(input.password)) {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle credential token is invalid");
  }
  return { username: input.username, password: input.password };
}

function parseHost(value: unknown): NativeOrdinaryAuthorityConfig["hosts"][number] {
  const input = exactRecord(value, hostKeys);
  if (typeof input.hostId !== "string") invalid();
  if (!isBundleToken(input.hostToken)) {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle host token is invalid");
  }
  return {
    hostId: input.hostId,
    hostToken: input.hostToken,
    capacities: array(input.capacities).map(parseCapacity)
  };
}

function parseCapacity(value: unknown): NativeOrdinaryAuthorityConfig["hosts"][number]["capacities"][number] {
  const input = exactRecord(value, capacityKeys);
  if (typeof input.capacity !== "string" || typeof input.runnerBaseImage !== "string") invalid();
  return {
    capacity: input.capacity,
    runnerBaseImage: input.runnerBaseImage,
    bounds: parseBounds(input.bounds)
  };
}

function parseBounds(value: unknown): NativeCapacityPolicy["bounds"] {
  const input = exactRecord(value, boundKeys);
  if (typeof input.cpu !== "string" || typeof input.memoryBytes !== "string"
    || typeof input.pids !== "string" || typeof input.wallClockSeconds !== "string"
    || typeof input.outputBytes !== "string") invalid();
  return {
    cpu: input.cpu,
    memoryBytes: input.memoryBytes,
    pids: input.pids,
    wallClockSeconds: input.wallClockSeconds,
    outputBytes: input.outputBytes
  };
}

function assertUniqueHosts(hosts: NativeOrdinaryAuthorityConfig["hosts"]): void {
  const hostIds = new Set<string>();
  for (const host of hosts) {
    if (hostIds.has(host.hostId)) {
      throw new NativeOrdinaryBundleConfigError("ordinary CI bundle host IDs must be unique");
    }
    hostIds.add(host.hostId);
  }
}

function assertDistinctAuthority(config: NativeOrdinaryAuthorityConfig): void {
  const credentials = [
    ...Object.values(config.credentials),
    config.nativeGit.identity,
    config.nativeGit.attemptIssuer,
    config.nativeGit.resultReporter
  ];
  const values = [
    ...credentials.flatMap((credential) => [credential.username, credential.password]),
    ...config.hosts.map((host) => host.hostToken)
  ];
  if (new Set(values).size !== values.length) {
    throw new NativeOrdinaryBundleConfigError("ordinary CI bundle credentials must be globally distinct");
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => value[key] === undefined)) {
    return invalid();
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return invalid();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}

function isBundleToken(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

function invalid(): never {
  throw new NativeOrdinaryBundleConfigError("invalid ordinary CI bundle configuration");
}
