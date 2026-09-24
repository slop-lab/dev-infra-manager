import { lstat, readFile } from "node:fs/promises";
import { UserError } from "./errors.js";
import type { LifecycleOptions, ProjectRecord, QemuSchedulerProjectConnection } from "./lifecycleTypes.js";

const ROOT_FIELDS = ["schemaVersion", "transport", "hostId", "projects"] as const;
const PROJECT_FIELDS = ["projectId", "controllerEndpoint", "supervisorEndpoint", "webhookUrl", "hostToken", "webhookToken"] as const;
const TRANSPORTS = ["https", "loopback-http", "isolated-http"] as const;
type Transport = (typeof TRANSPORTS)[number];

export async function qemuSchedulerConnection(
  options: LifecycleOptions,
  project: Pick<ProjectRecord, "name" | "id">
): Promise<QemuSchedulerProjectConnection | undefined> {
  const configured = options.qemuSchedulerConnection;
  if (configured === undefined) return undefined;
  if (options.giteaConnection.kind !== "external") {
    throw new UserError("shared QEMU scheduling requires an external Gitea connection");
  }
  const metadata = await lstat(configured.file);
  if (!metadata.isFile()) throw new UserError("QEMU scheduler connection file must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new UserError("QEMU scheduler connection file must have mode 0600");
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new UserError("QEMU scheduler connection file must be owned by the DIM user");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(configured.file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("QEMU scheduler connection file must contain valid JSON");
    throw error;
  }
  const root = exactRecord(value, ROOT_FIELDS, "QEMU scheduler connection");
  if (root.schemaVersion !== 1) throw new UserError("QEMU scheduler connection schemaVersion must be 1");
  const transport = parseTransport(root.transport);
  const hostId = identifier(root.hostId, "hostId");
  if (!isRecord(root.projects)) throw new UserError("QEMU scheduler projects must be an object");
  const rawProject = root.projects[project.name];
  if (rawProject === undefined) throw new UserError(`QEMU scheduler connection has no explicit Project binding for '${project.name}'`);
  const input = exactRecord(rawProject, PROJECT_FIELDS, `QEMU scheduler Project '${project.name}'`);
  const projectId = identifier(input.projectId, `projects.${project.name}.projectId`);
  if (projectId !== project.id) throw new UserError(`QEMU scheduler Project '${project.name}' identity does not match local Project state`);
  return {
    projectId,
    hostId,
    controllerEndpoint: endpoint(input.controllerEndpoint, "controllerEndpoint", transport, false),
    supervisorEndpoint: endpoint(input.supervisorEndpoint, "supervisorEndpoint", transport, false),
    webhookUrl: webhookEndpoint(input.webhookUrl, transport, projectId),
    hostToken: text(input.hostToken, `projects.${project.name}.hostToken`),
    webhookToken: text(input.webhookToken, `projects.${project.name}.webhookToken`)
  };
}

function parseTransport(value: unknown): Transport {
  if (typeof value !== "string" || !TRANSPORTS.includes(value as Transport)) {
    throw new UserError(`QEMU scheduler transport must be one of ${TRANSPORTS.join(", ")}`);
  }
  return value as Transport;
}

function endpoint(value: unknown, name: string, transport: Transport, webhook: boolean): string {
  const raw = text(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) throw new UserError(`QEMU scheduler ${name} must be an absolute URL`);
    throw error;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new UserError(`QEMU scheduler ${name} must not contain credentials, query, or fragment`);
  }
  if (!webhook && url.pathname !== "" && url.pathname !== "/") throw new UserError(`QEMU scheduler ${name} must not contain a path`);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  const valid = transport === "https"
    ? url.protocol === "https:"
    : transport === "loopback-http"
      ? url.protocol === "http:" && loopback
      : url.protocol === "http:";
  if (!valid) throw new UserError(`QEMU scheduler ${name} does not match configured ${transport} transport`);
  return raw.replace(/\/$/, "");
}

function webhookEndpoint(value: unknown, transport: Transport, projectId: string): string {
  const parsed = endpoint(value, "webhookUrl", transport, true);
  if (new URL(parsed).pathname !== `/v1/webhooks/${encodeURIComponent(projectId)}/workflow-job`) {
    throw new UserError(`QEMU scheduler webhookUrl must end at /v1/webhooks/${projectId}/workflow-job`);
  }
  return parsed;
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new UserError(`${label} must be an object`);
  const unexpected = Object.keys(value).find((field) => !fields.includes(field));
  if (unexpected !== undefined) throw new UserError(`${label} contains unknown field '${unexpected}'`);
  const missing = fields.find((field) => value[field] === undefined);
  if (missing !== undefined) throw new UserError(`${label}.${missing} is required`);
  return value;
}

function identifier(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed)) throw new UserError(`QEMU scheduler ${name} is not a safe identifier`);
  return parsed;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`QEMU scheduler ${name} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
