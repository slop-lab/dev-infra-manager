import { ciQueryConnectionSchema } from "./ci/queryClient.js";
import { parseControlPlaneServicePair } from "./controlPlaneServicePair.js";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "@slop-lab/dim-core";
import { parseNativeGitBundleConfig } from "@slop-lab/dim-native-git/service";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type { NativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import { compileNativeRootBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";
import { parseNativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { parseNativeGitProjectRegistrarConnection } from "./nativeGitProjectRegistrarConnection.js";
import { parseNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";

type Credential = { username: string; password: string };
const imagePattern = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

export interface PrepareControlPlaneOptions {
  readonly directory: string;
  readonly nativeGitImage: string;
  readonly ordinaryCiImage: string;
  readonly hostId?: string;
  readonly nativeGitPort?: number;
  readonly ordinaryCiPort?: number;
}

/** Reviewed deployment material belongs to the service composition, not the installer. */
export async function prepareControlPlane(options: PrepareControlPlaneOptions): Promise<{ configFile: string; hostId: string }> {
  const directory = path.resolve(options.directory);
  const hostId = options.hostId ?? "operator";
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(hostId)) throw new UserError("host ID must contain 1–40 lower-case letters, digits or hyphens");
  if (![options.nativeGitImage, options.ordinaryCiImage].every((image) => imagePattern.test(image))) {
    throw new UserError("control-plane images must be registry references pinned by complete sha256 digests");
  }
  const nativePort = port(options.nativeGitPort ?? 8787);
  const ordinaryPort = port(options.ordinaryCiPort ?? 8788);
  if (nativePort === ordinaryPort) throw new UserError("control-plane published ports must be distinct");
  const credential = (username: string): Credential => ({ username, password: randomBytes(32).toString("base64url") });
  const roles = Object.fromEntries(["query", "grantIssuer", "candidateReader", "resultReporter", "webhook"]
    .map((role) => [role, credential(`service-${role}`)])) as Record<string, Credential>;
  const hostRole = (role: string) => ({ hostId, ...credential(`${hostId}-${role}`) });
  const native = {
    schemaVersion: 7, serviceId: "native-main", host: "0.0.0.0", port: 8080,
    storageRoot: "/var/lib/dim-native-git", gitExecutable: "/usr/bin/git", gitVersion: "2.39.5",
    projectRegistrars: [hostRole("registrar")],
    projectRootImporters: [hostRole("importer")], projectRootReadIssuers: [hostRole("reader")],
    workspaceWriteIssuers: [hostRole("writer")],
    humanReviewers: [{ reviewerId: "owner", ...credential("reviewer-owner") }], hostPromoters: [hostRole("promoter")],
    ci: { grantIssuer: roles.grantIssuer, candidateReader: roles.candidateReader, resultReporter: roles.resultReporter,
      webhook: { endpoint: "http://ordinary-ci:8080/v1/jobs", ...roles.webhook } }
  };
  const ordinary = {
    schemaVersion: 1, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://native-git:8080", grantIssuer: roles.grantIssuer,
      candidateReader: roles.candidateReader, resultReporter: roles.resultReporter },
    credentials: { webhook: roles.webhook, query: roles.query }, workers: []
  };
  parseControlPlaneServicePair(native, ordinary);
  const reviewPolicy = { schemaVersion: 1, rootAlias: "root",
    review: { requiredReviewerIds: ["owner"], requiredJobs: [] } };
  compileNativeRootBootstrapPolicy({ rootAlias: reviewPolicy.rootAlias, protectedRef: "refs/heads/main", review: reviewPolicy.review });
  const service = (name: string, image: string, publishedPort: number) => ({ image,
    configFile: path.join(directory, `${name}.json`), readinessTokenFile: path.join(directory, `${name}-readiness.token`),
    publish: { host: "127.0.0.1", port: publishedPort } });
  const install = { schemaVersion: 1, deploymentId: "dim", nativeGit: service("native-git", options.nativeGitImage, nativePort),
    ordinaryCi: service("ordinary-ci", options.ordinaryCiImage, ordinaryPort) };
  await privateDirectory(directory, async () => {
    await json(path.join(directory, "native-git.json"), native);
    await json(path.join(directory, "ordinary-ci.json"), ordinary);
    for (const name of ["native-git", "ordinary-ci"]) await writeFile(path.join(directory, `${name}-readiness.token`),
      `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    await json(path.join(directory, "install.json"), install);
    await json(path.join(directory, "review-policy.json"), reviewPolicy);
  });
  return { configFile: path.join(directory, "install.json"), hostId };
}

/** Bind client credentials to the generation attested by the live deployed service. */
export async function connectControlPlane(directoryInput: string, options: {
  readonly endpoint?: string; readonly ciEndpoint?: string; readonly outputDirectory?: string; readonly client?: NativeGitAdmissionHttpClient; readonly signal?: AbortSignal;
} = {}): Promise<{ directory: string; generationId: string; hostId: string }> {
  const directory = path.resolve(directoryInput);
  const native = parseNativeGitBundleConfig(await privateJson(path.join(directory, "native-git.json")));
  const install = await privateJson(path.join(directory, "install.json")) as { nativeGit?: { publish?: { host?: unknown; port?: unknown } }; ordinaryCi?: { publish?: { host?: unknown; port?: unknown } } };
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
  const importerConnection = parseNativeGitRootImporterConnection({ schemaVersion: 1, endpoint, serviceId: "native-main",
    role: "operator-root-importer", hostId, generationId, credential: importerCredential });
  const registrarConnection = parseNativeGitProjectRegistrarConnection({ schemaVersion: 1, endpoint, serviceId: "native-main",
    hostId, generationId, credential: registrarCredential });
  const hostConnection = parseNativeControlPlaneConnection({ schemaVersion: 1, hostId, nativeGit: {
    transport: "loopback-http", endpoint, serviceId: "native-main", generationId,
    workspaceWriteIssuer: { ...selected(native.workspaceWriteIssuers), username: hostId }, rootReadIssuer: selected(native.projectRootReadIssuers)
  } });
  const ciPublish = install.ordinaryCi?.publish;
  if (ciPublish?.host !== "127.0.0.1" || typeof ciPublish.port !== "number") throw new UserError("prepared CI loopback endpoint is invalid");
  const { ordinary } = parseControlPlaneServicePair(native, await privateJson(path.join(directory, "ordinary-ci.json")));
  const ciQueryConnection = ciQueryConnectionSchema.parse({ schemaVersion: 1, role: "query", generationId,
    endpoint: options.ciEndpoint ?? `http://127.0.0.1:${port(ciPublish.port)}`, credential: ordinary.credentials.query });
  const output = path.resolve(options.outputDirectory ?? path.join(directory, "connections"));
  await privateDirectory(output, async () => {
    await json(path.join(output, "registrar.json"), registrarConnection);
    await json(path.join(output, "importer.json"), importerConnection);
    await json(path.join(output, "host.json"), hostConnection);
    await json(path.join(output, "ci-query.json"), ciQueryConnection);
    await json(path.join(output, "reviewer.json"), { schemaVersion: 1, serviceId: "native-main", baseUrl: endpoint,
      reviewerId: reviewer.reviewerId, username: reviewer.username, password: reviewer.password, generationId });
    await json(path.join(output, "promoter.json"), { schemaVersion: 1, serviceId: "native-main", endpoint,
      role: "host-promoter", hostId, generationId, credential: promoterCredential });
  });
  return { directory: output, generationId, hostId };
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
