import { readFile } from "node:fs/promises";
import { ProtocolError, type SshBrokerConfig } from "@slop-lab/dim-core";

const CONFIG_FIELDS = ["schemaVersion", "approvalRoot", "broker", "workloads"] as const;
const BROKER_FIELDS = [
  "host", "user", "port", "identityFile", "knownHostsFile", "timeoutMs", "maxResponseBytes"
] as const;

export type LocalConfig = {
  readonly schemaVersion: 1;
  readonly approvalRoot: string;
  readonly broker: SshBrokerConfig;
  readonly workloads: Readonly<Record<string, readonly string[]>>;
};

export async function readLocalConfig(target: string): Promise<LocalConfig> {
  return parseLocalConfig(JSON.parse(await readFile(target, "utf8")));
}

export function parseLocalConfig(value: unknown): LocalConfig {
  const record = object(value, "local config");
  if (record.schemaVersion !== 1) {
    throw new ProtocolError(
      `local config uses unsupported schema ${String(record.schemaVersion)}; expected 1. `
      + "export needed data and recreate this config; DIM will not accept obsolete state"
    );
  }
  exactFields(record, CONFIG_FIELDS, "local config");
  const broker = exactRecord(record.broker, BROKER_FIELDS, "broker config");
  const workloads = object(record.workloads, "workloads");
  return {
    schemaVersion: 1,
    approvalRoot: absolutePath(record.approvalRoot, "approvalRoot"),
    broker: {
      host: text(broker.host, "broker.host"),
      user: text(broker.user, "broker.user"),
      port: positiveInteger(broker.port, "broker.port"),
      identityFile: absolutePath(broker.identityFile, "broker.identityFile"),
      knownHostsFile: absolutePath(broker.knownHostsFile, "broker.knownHostsFile"),
      timeoutMs: positiveInteger(broker.timeoutMs, "broker.timeoutMs"),
      maxResponseBytes: positiveInteger(broker.maxResponseBytes, "broker.maxResponseBytes")
    },
    workloads: Object.fromEntries(Object.entries(workloads).map(([id, command]) => {
      if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(id) || !Array.isArray(command) || command.length === 0) {
        throw new ProtocolError(`workload '${id}' is invalid`);
      }
      return [id, command.map((argument) => text(argument, `workload '${id}' argument`))];
    }))
  };
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  const record = object(value, label);
  exactFields(record, fields, label);
  return record;
}

function exactFields(record: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const unknown = Object.keys(record).find((field) => !fields.includes(field));
  if (unknown !== undefined) throw new ProtocolError(`${label} contains unknown field '${unknown}'`);
  const missing = fields.find((field) => record[field] === undefined);
  if (missing !== undefined) throw new ProtocolError(`${label}.${missing} is required`);
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new ProtocolError(`${label} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError(`${label} is invalid`);
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!parsed.startsWith("/")) throw new ProtocolError(`${label} must be an absolute local path`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolError(`${label} must be a positive integer`);
  }
  return value;
}
