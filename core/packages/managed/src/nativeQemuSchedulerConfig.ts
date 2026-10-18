import { isAbsolute } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "@slop-lab/dim-core";

const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const usernamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

export type NativeQemuCredential = { readonly username: string; readonly password: string };
export type NativeQemuCapacity = {
  readonly capacity: string;
  readonly runnerBaseImage: string;
  readonly jobBaseImage: string;
  readonly bounds: { readonly cpu: string; readonly memoryBytes: string; readonly pids: string;
    readonly wallClockSeconds: string; readonly outputBytes: string };
};
export type NativeQemuSchedulerConfig = {
  readonly schemaVersion: 2;
  readonly serviceId: "qemu-main";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly eligibilityLeaseMilliseconds: number;
  readonly claimLeaseMilliseconds: number;
  readonly nativeGit: { readonly endpoint: string; readonly serviceId: "native-main";
    readonly identity: NativeQemuCredential; readonly attemptIssuer: NativeQemuCredential;
    readonly candidateReader: NativeQemuCredential;
    readonly resultReporter: NativeQemuCredential };
  readonly credentials: { readonly eventIntake: NativeQemuCredential; readonly query: NativeQemuCredential };
  readonly hosts: readonly { readonly hostId: string; readonly hostToken: string;
    readonly capacities: readonly NativeQemuCapacity[] }[];
};

export function nativeQemuExecutionAuthorityJson(
  config: Pick<NativeQemuSchedulerConfig, "hosts">
): string {
  return JSON.stringify([...config.hosts]
    .sort((left, right) => lexical(left.hostId, right.hostId))
    .map((host) => ({ hostId: host.hostId, capacities: [...host.capacities]
      .sort((left, right) => lexical(left.capacity, right.capacity))
      .map((entry) => ({ capacity: entry.capacity, runnerBaseImage: entry.runnerBaseImage,
        jobBaseImage: entry.jobBaseImage, bounds: { cpu: entry.bounds.cpu,
          memoryBytes: entry.bounds.memoryBytes, pids: entry.bounds.pids,
          wallClockSeconds: entry.bounds.wallClockSeconds, outputBytes: entry.bounds.outputBytes } })) })));
}

function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export class NativeQemuSchedulerConfigError extends UserError {
  readonly name = "NativeQemuSchedulerConfigError";
}

export function parseNativeQemuSchedulerConfig(value: unknown): NativeQemuSchedulerConfig {
  const root = exact(value, ["schemaVersion", "serviceId", "host", "port", "database",
    "eligibilityLeaseMilliseconds", "claimLeaseMilliseconds", "nativeGit", "credentials", "hosts"]);
  if (root.schemaVersion !== 2 || root.serviceId !== "qemu-main" || typeof root.host !== "string"
    || root.host.length === 0 || !isAbsolutePath(root.database)) invalid();
  const claimLeaseMilliseconds = integer(root.claimLeaseMilliseconds);
  if (claimLeaseMilliseconds < 60_000) {
    throw new NativeQemuSchedulerConfigError("native QEMU scheduler claim lease must be at least 60000 milliseconds");
  }
  const nativeGit = exact(root.nativeGit,
    ["endpoint", "serviceId", "identity", "attemptIssuer", "candidateReader", "resultReporter"]);
  if (nativeGit.serviceId !== "native-main") invalid();
  const credentials = exact(root.credentials, ["eventIntake", "query"]);
  if (!Array.isArray(root.hosts) || root.hosts.length === 0) invalid();
  const hosts = root.hosts.map(parseHost);
  unique(hosts.map(({ hostId }) => hostId));
  const parsed: NativeQemuSchedulerConfig = {
    schemaVersion: 2, serviceId: "qemu-main", host: root.host, port: port(root.port),
    database: root.database, eligibilityLeaseMilliseconds: integer(root.eligibilityLeaseMilliseconds),
    claimLeaseMilliseconds,
    nativeGit: { endpoint: origin(nativeGit.endpoint), serviceId: "native-main",
      identity: credential(nativeGit.identity), attemptIssuer: credential(nativeGit.attemptIssuer),
      candidateReader: credential(nativeGit.candidateReader),
      resultReporter: credential(nativeGit.resultReporter) },
    credentials: { eventIntake: credential(credentials.eventIntake), query: credential(credentials.query) },
    hosts
  };
  const authority = [...Object.values(parsed.nativeGit).filter(isCredential),
    ...Object.values(parsed.credentials), ...hosts.map(({ hostToken }) => hostToken)]
    .flatMap((entry) => typeof entry === "string" ? [entry] : [entry.username, entry.password]);
  if (new Set(authority).size !== authority.length) {
    throw new NativeQemuSchedulerConfigError("native QEMU scheduler credentials must be globally distinct");
  }
  return parsed;
}

export async function loadNativeQemuSchedulerConfig(path: string): Promise<NativeQemuSchedulerConfig> {
  if (!isAbsolute(path)) throw new NativeQemuSchedulerConfigError("native QEMU scheduler config path must be absolute");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const owner = process.geteuid?.();
    if (!metadata.isFile() || owner === undefined || metadata.uid !== owner || metadata.nlink !== 1
      || ![0o400, 0o600].includes(metadata.mode & 0o777) || metadata.size < 1 || metadata.size > 64 * 1024) invalid();
    return parseNativeQemuSchedulerConfig(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
}

function parseHost(value: unknown): NativeQemuSchedulerConfig["hosts"][number] {
  const input = exact(value, ["hostId", "hostToken", "capacities"]);
  if (!Array.isArray(input.capacities) || input.capacities.length === 0) invalid();
  const capacities = input.capacities.map(parseCapacity);
  unique(capacities.map(({ capacity }) => capacity));
  return { hostId: identifier(input.hostId), hostToken: token(input.hostToken), capacities };
}
function parseCapacity(value: unknown): NativeQemuCapacity {
  const input = exact(value, ["capacity", "runnerBaseImage", "jobBaseImage", "bounds"]);
  const bounds = exact(input.bounds, ["cpu", "memoryBytes", "pids", "wallClockSeconds", "outputBytes"]);
  return { capacity: identifier(input.capacity), runnerBaseImage: image(input.runnerBaseImage),
    jobBaseImage: image(input.jobBaseImage), bounds: { cpu: decimal(bounds.cpu),
      memoryBytes: decimal(bounds.memoryBytes), pids: decimal(bounds.pids),
      wallClockSeconds: decimal(bounds.wallClockSeconds), outputBytes: decimal(bounds.outputBytes) } };
}
function credential(value: unknown): NativeQemuCredential {
  const input = exact(value, ["username", "password"]);
  if (typeof input.username !== "string" || !usernamePattern.test(input.username)) invalid();
  return { username: input.username, password: token(input.password) };
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
function port(value: unknown): number { const parsed = integer(value); if (parsed > 65_535) invalid(); return parsed; }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) invalid(); return value;
}
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) invalid(); return value;
}
function image(value: unknown): string { if (typeof value !== "string" || !imagePattern.test(value)) invalid(); return value; }
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) invalid();
  return value;
}
function origin(value: unknown): string {
  if (typeof value !== "string") invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { return invalid(); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value
    || parsed.username !== "" || parsed.password !== "") invalid();
  return value;
}
function unique(values: readonly string[]): void { if (new Set(values).size !== values.length) invalid(); }
function isCredential(value: unknown): value is NativeQemuCredential {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "username");
}
function isAbsolutePath(value: unknown): value is string { return typeof value === "string" && isAbsolute(value) && value !== "/"; }
function invalid(): never { throw new NativeQemuSchedulerConfigError("invalid native QEMU scheduler configuration"); }
