import path from "node:path";
import { randomBytes } from "node:crypto";

const requiredCapabilityPlugins = ["agent-tools", "host-llm-router", "external-urls", "native-git"] as const;
const shaPattern = /^[0-9a-f]{40}$/;
const hostPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const workspacePattern = /^dim-smoke-[a-z0-9][a-z0-9-]{0,37}$/;
const ingressPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OperatorArguments = {
  readonly configPath: string;
  readonly hosts: readonly string[];
  readonly preflightOnly: boolean;
  readonly json: boolean;
};

export type MonitorProfile = {
  readonly parentSessionId: string;
  readonly directory: string;
  readonly maxSessions: number;
  readonly maxDepth: number;
  readonly maxRequests: number;
  readonly recentMessages: number;
  readonly staleMinutes: number;
  readonly deadlineSeconds: number;
  readonly requestTimeoutSeconds: number;
  readonly omoMetadataPath?: string;
};

export type HostProfile = {
  readonly name: string;
  readonly workspace: string;
  readonly source: string;
  readonly workspaceSourceSha: string;
  readonly expectedHostVersion: string;
  readonly requiredPlugins: readonly string[];
  readonly ingress: string;
  readonly sshPublicKey: string;
  readonly llm: { readonly configFile: string; readonly project: string; readonly route: string };
  readonly monitor?: MonitorProfile;
};

export type SmokeConfiguration = {
  readonly installedSourceSha: string;
  readonly hosts: readonly HostProfile[];
};

export type OwnedWorkspace = { readonly name: string; readonly id: string };
export function smokeWorkspaceName(prefix: string): string {
  if (!workspacePattern.test(prefix)) throw new OperatorInputError("invalid owned smoke workspace prefix");
  return `${prefix.slice(0, 27)}-${randomBytes(10).toString("hex")}`;
}

export class OperatorInputError extends Error {
  readonly name = "OperatorInputError";
}
export class SmokeFailure extends Error {
  readonly name = "SmokeFailure";
  readonly host: string;
  readonly step: string;
  constructor(host: string, step: string, detail: string) { super(`${host}: ${step}: ${detail}`); this.host = host; this.step = step; }
}

export const helpText = `Usage: selected-host-usability-smoke.ts --config ABSOLUTE_FILE --host NAME [--host NAME...] [--preflight-only] [--json]

Every host must be named explicitly. The runner never uses the current/default host.
--preflight-only checks versions, readiness, plugins and workspace-name ownership without creating a workspace.`;

export function parseOperatorArguments(values: readonly string[]): OperatorArguments {
  let configPath: string | undefined;
  const hosts: string[] = [];
  let preflightOnly = false;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--preflight-only") preflightOnly = true;
    else if (value === "--json") json = true;
    else if (value === "--config") configPath = requiredValue(values, ++index, "--config");
    else if (value === "--host") hosts.push(requiredValue(values, ++index, "--host"));
    else throw new OperatorInputError("unknown argument; use --help for the supported flags");
  }
  if (configPath === undefined || !path.isAbsolute(configPath)) throw new OperatorInputError("--config must select an absolute reviewed JSON file");
  if (hosts.length === 0) throw new OperatorInputError("at least one explicit --host is required; the current host is never used implicitly");
  if (new Set(hosts).size !== hosts.length) throw new OperatorInputError("each --host may be selected only once");
  for (const host of hosts) if (!hostPattern.test(host)) throw new OperatorInputError(`invalid host name: ${host}`);
  return { configPath, hosts, preflightOnly, json };
}

export function parseSmokeConfiguration(value: unknown): SmokeConfiguration {
  const root = object(value, "configuration");
  exactKeys(root, ["schemaVersion", "installedSourceSha", "hosts"], "configuration");
  if (root["schemaVersion"] !== 1) throw new OperatorInputError("configuration schemaVersion must be 1");
  const installedSourceSha = string(root["installedSourceSha"], "installedSourceSha");
  if (!shaPattern.test(installedSourceSha)) throw new OperatorInputError("installedSourceSha must be an exact lowercase 40-hex commit");
  if (!Array.isArray(root["hosts"]) || root["hosts"].length === 0) throw new OperatorInputError("configuration hosts must be a non-empty array");
  const hosts = root["hosts"].map((entry, index) => parseHostProfile(entry, index));
  if (new Set(hosts.map(({ name }) => name)).size !== hosts.length) throw new OperatorInputError("configuration host names must be unique");
  if (new Set(hosts.map(({ workspace }) => workspace)).size !== hosts.length) throw new OperatorInputError("workspace names must be unique across selected hosts");
  return { installedSourceSha, hosts };
}

export function ownedWorkspaceName(expectedName: string, value: unknown): OwnedWorkspace {
  const record = object(value, "workspace record");
  const name = string(record["name"], "workspace record name");
  const id = string(record["id"], "workspace record id");
  if (name !== expectedName || !workspacePattern.test(name) || !uuidPattern.test(id)) {
    throw new OperatorInputError("workspace ownership could not be proven; refusing destructive cleanup");
  }
  return { name, id };
}

export function ownedPartialWorkspace(claim: { readonly name: string; readonly source: string; readonly startedAt: number }, value: unknown): OwnedWorkspace {
  const entry = object(value, "partial workspace ownership"), source = object(entry["source"], "partial workspace source ownership");
  const url = source["url"], created = entry["createdAt"];
  const repository = typeof url === "string" && url.startsWith(`${claim.source}/`) ? url.slice(claim.source.length + 1) : undefined;
  if (typeof url !== "string" || url !== claim.source && (repository === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(repository))
    || typeof created !== "string" || !Number.isFinite(Date.parse(created)) || Date.parse(created) < claim.startedAt - 1000) {
    throw new OperatorInputError("partial workspace ownership conflicts; resource retained for operator inspection");
  }
  return ownedWorkspaceName(claim.name, entry);
}

function parseHostProfile(value: unknown, index: number): HostProfile {
  const label = `hosts[${index}]`, entry = object(value, label);
  exactKeys(entry, ["name", "workspace", "source", "workspaceSourceSha", "expectedHostVersion", "requiredPlugins", "ingress", "sshPublicKey", "llm", "monitor"], label,
    ["name", "workspace", "source", "workspaceSourceSha", "expectedHostVersion", "requiredPlugins", "ingress", "sshPublicKey", "llm"]);
  const name = string(entry["name"], `${label}.name`);
  const workspace = string(entry["workspace"], `${label}.workspace`);
  const source = string(entry["source"], `${label}.source`);
  const workspaceSourceSha = string(entry["workspaceSourceSha"], `${label}.workspaceSourceSha`);
  const expectedHostVersion = string(entry["expectedHostVersion"], `${label}.expectedHostVersion`);
  const ingress = string(entry["ingress"], `${label}.ingress`);
  const sshPublicKey = string(entry["sshPublicKey"], `${label}.sshPublicKey`);
  if (!hostPattern.test(name)) throw new OperatorInputError(`${label}.name is invalid`);
  if (!workspacePattern.test(workspace)) throw new OperatorInputError(`${label}.workspace must use the dim-smoke- ownership namespace`);
  if (!/^dim:\/\/dim-smoke-[a-z0-9][a-z0-9-]{0,37}$/.test(source)) throw new OperatorInputError(`${label}.source must select an operator-provisioned disposable dim://dim-smoke-PROJECT`);
  if (!shaPattern.test(workspaceSourceSha)) throw new OperatorInputError(`${label}.workspaceSourceSha must be an exact lowercase 40-hex commit`);
  if (!expectedHostVersion.trim()) throw new OperatorInputError(`${label}.expectedHostVersion is required`);
  if (!ingressPattern.test(ingress)) throw new OperatorInputError(`${label}.ingress is invalid`);
  if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]{1,200})?$/.test(sshPublicKey)) throw new OperatorInputError(`${label}.sshPublicKey must be one OpenSSH public key without options`);
  if (!Array.isArray(entry["requiredPlugins"]) || !entry["requiredPlugins"].every((plugin) => typeof plugin === "string")) {
    throw new OperatorInputError(`${label}.requiredPlugins must be a string array`);
  }
  const requiredPlugins = [...entry["requiredPlugins"]];
  for (const required of requiredCapabilityPlugins) {
    if (!requiredPlugins.includes(required)) throw new OperatorInputError(`${label}.requiredPlugins must include ${required}`);
  }
  const monitor = entry["monitor"] === undefined ? undefined : parseMonitorProfile(entry["monitor"], `${label}.monitor`);
  const llm = object(entry["llm"], `${label}.llm`); exactKeys(llm, ["configFile", "project", "route"], `${label}.llm`);
  const configFile = string(llm["configFile"], "LLM config path"), project = string(llm["project"], "LLM project"), route = string(llm["route"], "LLM route");
  if (!path.isAbsolute(configFile) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(project) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(route)) throw new OperatorInputError("invalid explicit LLM attachment selection");
  return { name, workspace, source, workspaceSourceSha, expectedHostVersion, requiredPlugins, ingress, sshPublicKey,
    llm: { configFile, project, route }, ...(monitor === undefined ? {} : { monitor }) };
}

export function parseMonitorProfile(value: unknown, label: string): MonitorProfile {
  const entry = object(value, label);
  const required = ["parentSessionId", "directory", "maxSessions", "maxDepth", "maxRequests", "recentMessages", "staleMinutes", "deadlineSeconds", "requestTimeoutSeconds"] as const;
  exactKeys(entry, [...required, "omoMetadataPath"], label, required);
  const parentSessionId = string(entry["parentSessionId"], `${label}.parentSessionId`);
  const directory = string(entry["directory"], `${label}.directory`);
  if (!/^ses_[A-Za-z0-9]+$/.test(parentSessionId)) throw new OperatorInputError(`${label}.parentSessionId is invalid`);
  if (!path.isAbsolute(directory)) throw new OperatorInputError(`${label}.directory must be absolute`);
  const number = (key: typeof required[number], maximum: number): number => {
    const found = entry[key];
    if (!Number.isInteger(found) || typeof found !== "number" || found < 1 || found > maximum) throw new OperatorInputError(`${label}.${key} must be between 1 and ${maximum}`);
    return found;
  };
  const omoMetadataPath = entry["omoMetadataPath"] === undefined ? undefined : string(entry["omoMetadataPath"], `${label}.omoMetadataPath`);
  if (omoMetadataPath !== undefined && !path.posix.isAbsolute(omoMetadataPath)) throw new OperatorInputError(`${label}.omoMetadataPath must be an absolute guest path`);
  return {
    parentSessionId, directory, maxSessions: number("maxSessions", 200), maxDepth: number("maxDepth", 16),
    maxRequests: number("maxRequests", 500), recentMessages: number("recentMessages", 20), staleMinutes: number("staleMinutes", 1440),
    deadlineSeconds: number("deadlineSeconds", 300), requestTimeoutSeconds: number("requestTimeoutSeconds", 30),
    ...(omoMetadataPath === undefined ? {} : { omoMetadataPath })
  };
}

function requiredValue(values: readonly string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--")) throw new OperatorInputError(`${flag} requires a value`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperatorInputError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OperatorInputError(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, required: readonly string[] = allowed): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new OperatorInputError(`${label} contains unknown key: ${extras[0]}`);
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) throw new OperatorInputError(`${label} is missing key: ${missing[0]}`);
}
