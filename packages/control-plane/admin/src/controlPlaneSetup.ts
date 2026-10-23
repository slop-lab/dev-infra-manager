import { executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { executionProfileSchema, type ExecutionProfile } from "@slop-lab/dim-contracts-ci/execution";
import { ciQueryConnectionSchema } from "@slop-lab/dim-contracts-ci/connections";
import { parseControlPlaneServicePair, parseManagedGitServiceConfig } from "./service-pair.js";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "@slop-lab/dim-host-core";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { compileNativeRepositoryBootstrapPolicy } from "@slop-lab/dim-host-plugin-native-git";
import { parseNativeControlPlaneConnection } from "@slop-lab/dim-host-plugin-native-git";
import { parseNativeGitProjectRegistrarConnection } from "@slop-lab/dim-host-plugin-native-git";
import { parseNativeGitRootImporterConnection } from "@slop-lab/dim-host-plugin-native-git";

type Credential = { username: string; password: string };
const imagePattern = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

export interface PrepareControlPlaneOptions {
  readonly directory: string;
  readonly nativeGitImage: string;
  readonly executionImage: string;
  readonly hostId?: string;
  readonly nativeGitPort?: number;
  readonly executionPort?: number;
  readonly executionWorker?: string;
  readonly ciContainerSlots?: number;
  readonly ciVmSlots?: number;
  readonly ciRunnerImage?: string;
  readonly ciJobImage?: string;
  readonly ciContainerProfile?: unknown;
  readonly ciVmProfile?: unknown;
}

/** Reviewed deployment material belongs to the service composition, not the installer. */
export async function prepareControlPlane(options: PrepareControlPlaneOptions): Promise<{ configFile: string; hostId: string }> {
  const directory = path.resolve(options.directory);
  const hostId = options.hostId ?? "operator";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(hostId)) throw new UserError("host ID must contain 1–40 lower-case letters, digits or hyphens");
  if (![options.nativeGitImage, options.executionImage].every((image) => imagePattern.test(image))) {
    throw new UserError("control-plane images must be registry references pinned by complete sha256 digests");
  }
  const nativePort = port(options.nativeGitPort ?? 8787);
  const executionPort = port(options.executionPort ?? 8788);
  if (nativePort === executionPort) throw new UserError("control-plane published ports must be distinct");
  const slots = initialWorkerSlots(options);
  const credential = (username: string): Credential => ({ username, password: randomBytes(32).toString("base64url") });
  const roles = Object.fromEntries(["query", "operator", "grantIssuer", "candidateReader", "resultReporter", "webhook"]
    .map((role) => [role, credential(`service-${role}`)])) as Record<string, Credential>;
  const hostRole = (role: string) => ({ hostId, ...credential(`${hostId}-${role}`) });
  const native = {
    schemaVersion: 7, serviceId: "native-main", host: "0.0.0.0", port: 8080,
    storageRoot: "/var/lib/dim-native-git", gitExecutable: "/usr/bin/git", gitVersion: "2.39.5",
    projectRegistrars: [hostRole("registrar")],
    projectRootImporters: [hostRole("importer")], projectRootReadIssuers: [hostRole("reader")],
    workspaceWriteIssuers: [hostRole("writer")],
    gitSync: { operators: [hostRole("git-sync")] },
    humanReviewers: [{ reviewerId: "owner", ...credential("reviewer-owner") }], hostPromoters: [hostRole("promoter")],
    ci: { grantIssuer: roles.grantIssuer, candidateReader: roles.candidateReader, resultReporter: roles.resultReporter,
      webhook: { endpoint: "http://execution:8080/v1/jobs", ...roles.webhook } }
  };
  const execution = {
    schemaVersion: 1, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://native-git:8080", grantIssuer: roles.grantIssuer,
      candidateReader: roles.candidateReader, resultReporter: roles.resultReporter },
    credentials: { webhook: roles.webhook, query: roles.query, operator: roles.operator },
    workers: options.executionWorker === undefined ? [] : [{ id: options.executionWorker,
      token: randomBytes(32).toString("base64url"), slots }]
  };
  parseControlPlaneServicePair(native, execution);
  const repositoryPolicy = { schemaVersion: 1, repositoryId: "root", extensions: {
    "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [] },
    "git-ci": { requiredJobs: [], ciRepositoryIds: ["root"] }, "merge-policy": {} } };
  compileNativeRepositoryBootstrapPolicy({ repositoryId: repositoryPolicy.repositoryId, protectedRef: "refs/heads/main", extensions: repositoryPolicy.extensions });
  const service = (name: string, image: string, publishedPort: number) => ({ image,
    configFile: path.join(directory, `${name}.json`), readinessTokenFile: path.join(directory, `${name}-readiness.token`),
    publish: { host: "127.0.0.1", port: publishedPort } });
  const install = { schemaVersion: 1, deploymentId: "dim", nativeGit: service("native-git", options.nativeGitImage, nativePort),
    execution: service("execution", options.executionImage, executionPort) };
  await privateDirectory(directory, async () => {
    await json(path.join(directory, "native-git.json"), native);
    await json(path.join(directory, "execution.json"), execution);
    for (const name of ["native-git", "execution"]) await writeFile(path.join(directory, `${name}-readiness.token`),
      `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    await json(path.join(directory, "install.json"), install);
    await json(path.join(directory, "repository-policy.json"), repositoryPolicy);
  });
  return { configFile: path.join(directory, "install.json"), hostId };
}

/** Bind client credentials to the generation attested by the live deployed service. */
export async function connectControlPlane(directoryInput: string, options: {
  readonly endpoint?: string; readonly executionEndpoint?: string; readonly outputDirectory?: string; readonly executionWorkerStateDirectory?: string; readonly client?: NativeGitAdmissionHttpClient; readonly signal?: AbortSignal;
} = {}): Promise<{ directory: string; generationId: string; hostId: string; executionWorkerCount: number; workerConfigFile?: string }> {
  const directory = path.resolve(directoryInput);
  const native = parseManagedGitServiceConfig(await privateJson(path.join(directory, "native-git.json")));
  const install = await privateJson(path.join(directory, "install.json")) as { nativeGit?: { publish?: { host?: unknown; port?: unknown } }; execution?: { publish?: { host?: unknown; port?: unknown } } };
  const publish = install.nativeGit?.publish;
  if (publish?.host !== "127.0.0.1" || typeof publish.port !== "number") throw new UserError("prepared control-plane loopback endpoint is invalid");
  const endpoint = options.endpoint ?? `http://127.0.0.1:${port(publish.port)}`;
  // Existing host clients deliberately permit only loopback HTTP; use SSH forwarding for a remote service.
  const importer = native.projectRootImporters[0];
  if (importer === undefined) throw new UserError("prepared service has no root importer");
  const hostId = importer.hostId;
  const selected = (roles: readonly (Credential & { hostId: string })[]) => {
    const entry = roles.find((candidate) => candidate.hostId === hostId);
    if (entry === undefined) throw new UserError("prepared service is missing a host role");
    return { username: entry.username, password: entry.password };
  };
  const importerCredential = selected(native.projectRootImporters);
  // Parse before sending any credential, so an override cannot leak credentials to a non-loopback origin.
  parseNativeGitRootImporterConnection({ schemaVersion: 1, endpoint, serviceId: "native-main", role: "operator-root-importer",
    hostId, generationId: "0".repeat(64), credential: importerCredential });
  const client = options.client ?? createNodeNativeGitAdmissionHttpClient();
  const signal = options.signal ?? AbortSignal.timeout(10_000);
  const attest = async (role: string, credential: Credential, scope: { hostId: string } | { reviewerId: string } = { hostId }): Promise<Record<string, unknown>> => {
    const response = await client.request({ endpoint, method: "GET", path: `/v1/${role}-identity`,
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`, signal });
    if (response.statusCode !== 200 || response.contentType !== "application/json" || response.cacheControl !== "no-store") throw new UserError(`control-plane ${role} identity could not be verified`);
    let identity: Record<string, unknown>;
    try { identity = JSON.parse(response.body.toString("utf8")); } catch { throw new UserError("control-plane returned an invalid identity"); }
    if (identity === null || identity.schemaVersion !== 1 || identity.serviceId !== "native-main"
      || identity.role !== role || Object.entries(scope).some(([key, value]) => identity[key] !== value)) throw new UserError("control-plane identity conflicts with prepared credentials");
    return identity;
  };
  const identity = await attest("operator-root-importer", importerCredential);
  if (typeof identity.generationId !== "string" || !/^[0-9a-f]{64}$/.test(identity.generationId)) throw new UserError("control-plane returned an invalid generation");
  const generationId = identity.generationId;
  const registrarCredential = selected(native.projectRegistrars);
  await attest("operator-project-registrar", registrarCredential);
  for (const [role, credential] of [
    ["operator-workspace-write-issuer", selected(native.workspaceWriteIssuers)]
  ] as const) {
    const attested = await attest(role, credential);
    if (attested.generationId !== generationId) throw new UserError("control-plane generation changed while connecting");
  }
  const reviewer = native.humanReviewers[0];
  const promoterCredential = selected(native.hostPromoters);
  if (reviewer === undefined) throw new UserError("prepared service has no human reviewer");
  for (const attested of [await attest("human-reviewer", reviewer, { reviewerId: reviewer.reviewerId }),
    await attest("host-promoter", promoterCredential)]) {
    if (attested.generationId !== generationId) throw new UserError("control-plane generation changed while connecting");
  }
  const syncOperator = native.gitSync?.operators.find((candidate) => candidate.hostId === hostId);
  const syncCredential = syncOperator === undefined ? undefined : { username: syncOperator.username, password: syncOperator.password };
  if (syncCredential !== undefined) {
    const attested = await attest("git-sync-operator", syncCredential);
    if (attested.generationId !== generationId) throw new UserError("control-plane generation changed while connecting");
  }
  const importerConnection = parseNativeGitRootImporterConnection({ schemaVersion: 1, endpoint, serviceId: "native-main",
    role: "operator-root-importer", hostId, generationId, credential: importerCredential });
  const registrarConnection = parseNativeGitProjectRegistrarConnection({ schemaVersion: 1, endpoint, serviceId: "native-main",
    hostId, generationId, credential: registrarCredential });
  const hostConnection = parseNativeControlPlaneConnection({ schemaVersion: 1, hostId, nativeGit: {
    transport: "loopback-http", endpoint, serviceId: "native-main", generationId,
    workspaceWriteIssuer: selected(native.workspaceWriteIssuers), rootReadIssuer: selected(native.projectRootReadIssuers)
  } });
  const executionPublish = install.execution?.publish;
  if (executionPublish?.host !== "127.0.0.1" || typeof executionPublish.port !== "number") throw new UserError("prepared execution loopback endpoint is invalid");
  const { execution } = parseControlPlaneServicePair(native, await privateJson(path.join(directory, "execution.json")));
  const ciQueryConnection = ciQueryConnectionSchema.parse({ schemaVersion: 1, role: "query", generationId,
    endpoint: options.executionEndpoint ?? `http://127.0.0.1:${port(executionPublish.port)}`, credential: execution.credentials.query });
  const output = path.resolve(options.outputDirectory ?? path.join(directory, "connections"));
  const worker = execution.workers.length === 1 ? execution.workers[0] : undefined;
  if (worker === undefined && options.executionWorkerStateDirectory !== undefined) throw new UserError("no execution worker was prepared");
  const workerConfig = worker === undefined ? undefined : executionWorkerConfigSchema.parse({ schemaVersion: 1,
    workerId: worker.id, token: worker.token, generationId, gitExecutable: "/usr/bin/git",
    endpoint: ciQueryConnection.endpoint, nativeGitEndpoint: endpoint,
    stateDirectory: options.executionWorkerStateDirectory ?? path.join(directory, "worker-state"),
    slots: worker.slots.map((slot) => "runtime" in slot ? { id: slot.id, runtime: slot.runtime }
      : { id: slot.id, taskType: slot.taskType, handlerRevision: slot.handlerRevision }) });
  await privateDirectory(output, async () => {
    await json(path.join(output, "registrar.json"), registrarConnection);
    await json(path.join(output, "importer.json"), importerConnection);
    await json(path.join(output, "host.json"), hostConnection);
    if (syncCredential !== undefined) await json(path.join(output, "git-sync.json"), { schemaVersion: 1, serviceId: "native-main",
      role: "git-sync-operator", hostId, generationId, endpoint, credential: syncCredential });
    await json(path.join(output, "ci-query.json"), ciQueryConnection);
    await json(path.join(output, "execution-operator.json"), { ...ciQueryConnection, role: "operator", credential: execution.credentials.operator });
    if (workerConfig !== undefined) await json(path.join(output, "worker.json"), workerConfig);
    await json(path.join(output, "reviewer.json"), { schemaVersion: 1, serviceId: "native-main", baseUrl: endpoint,
      reviewerId: reviewer.reviewerId, username: reviewer.username, password: reviewer.password, generationId });
    await json(path.join(output, "promoter.json"), { schemaVersion: 1, serviceId: "native-main", endpoint,
      role: "host-promoter", hostId, generationId, credential: promoterCredential });
  });
  return { directory: output, generationId, hostId, executionWorkerCount: execution.workers.length, ...(workerConfig === undefined ? {} : { workerConfigFile: path.join(output, "worker.json") }) };
}

async function privateDirectory(directory: string, write: () => Promise<void>): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { throw new UserError(`refusing to replace an existing or unavailable setup directory: ${directory}`, { cause: error }); }
  try { await write(); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
async function json(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600
      || metadata.nlink !== 1 || metadata.size > 1024 * 1024) throw new UserError("control-plane setup requires private regular files");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
function port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new UserError("published port must be an integer from 1 through 65535");
  return value;
}

function initialWorkerSlots(options: PrepareControlPlaneOptions): { id: string; runtime: "container" | "vm"; profile: ExecutionProfile }[] {
  const sysbox = options.ciContainerSlots ?? 0, qemu = options.ciVmSlots ?? 0;
  if (![sysbox, qemu].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 64) || sysbox + qemu > 64) {
    throw new UserError("CI slot counts must be nonnegative integers with at most 64 total slots");
  }
  const configured = sysbox + qemu > 0 || [options.ciRunnerImage, options.ciJobImage,
    options.ciContainerProfile, options.ciVmProfile].some((value) => value !== undefined);
  if (options.executionWorker === undefined) {
    if (configured) throw new UserError("CI capacity requires --execution-worker");
    return [];
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(options.executionWorker) || sysbox + qemu === 0) {
    throw new UserError("CI worker requires a valid ID and at least one explicit slot");
  }
  if (options.ciContainerProfile !== undefined && (options.ciRunnerImage !== undefined || options.ciJobImage !== undefined)) {
    throw new UserError("choose a Sysbox profile file or runner/job images");
  }
  if (sysbox === 0 && [options.ciContainerProfile, options.ciRunnerImage, options.ciJobImage].some((value) => value !== undefined)
    || qemu === 0 && options.ciVmProfile !== undefined) throw new UserError("runtime profiles require matching CI slots");
  const sysboxProfile = options.ciContainerProfile ?? { runnerBaseImage: options.ciRunnerImage,
    jobBaseImage: options.ciJobImage,
    bounds: { cpu: "1", memoryBytes: "2147483648", pids: "512", wallClockSeconds: "900", outputBytes: "1048576" } };
  return ([{ runtime: "container", count: sysbox, profile: sysboxProfile },
    { runtime: "vm", count: qemu, profile: options.ciVmProfile }] as const).flatMap(({ runtime, count, profile }) => {
    if (count === 0) return [];
    const parsed = executionProfileSchema.safeParse(profile);
    if (!parsed.success) throw new UserError(`${runtime} CI slots require a valid reviewed profile with digest-pinned runner/job images and positive bounds`);
    return Array.from({ length: count }, (_, index) => ({ id: `${runtime}-${index + 1}`, runtime, profile: parsed.data }));
  });
}
