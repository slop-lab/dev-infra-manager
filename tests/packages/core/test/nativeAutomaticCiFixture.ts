import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionHttpClient.js";
import { createNativeQemuAuthorityClient, type NativeQemuAuthorityClient } from "../../../../core/packages/managed/src/nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerConfig } from "../../../../core/packages/managed/src/nativeQemuSchedulerConfig.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/managed/src/nativeQemuSchedulerService.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../core/packages/managed/src/nativeOrdinaryBundleConfig.js";
import { configuredNativeRootAdmissionServer,
  type NativeRootAdmissionServiceOptions } from "../../../../core/packages/managed/src/nativeRootAdmissionService.js";
import { createNodeAdmissionVerifierHttpClient, type AdmissionVerifierHttpClient } from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { authoritativePolicy } from "../../native-git/test/authoritativeNativeCandidateFixture.js";
import { bundleSecrets, idleOrdinaryConfig } from "../../native-git/test/bundleConfigFixture.js";
import { nativeBundleReviewFixture, type NativeBundleReviewFixture } from "../../native-git/test/nativeBundleReviewFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const ordinaryReadinessToken = token("m");
const ordinaryActivationToken = token("n");
const ordinaryHostBToken = token("o");

export type NativeAutomaticCiFixture = {
  readonly native: NativeBundleReviewFixture;
  readonly ordinaryOrigin: string;
  readonly ordinaryDatabase: string;
  readonly qemuOrigin: string;
  readonly qemuDatabase: string;
  readonly qemuConfig: NativeQemuSchedulerConfig;
  stopOrdinary(): Promise<void>;
  startOrdinary(): Promise<void>;
  close(): Promise<void>;
};

export async function nativeAutomaticCiFixture(): Promise<NativeAutomaticCiFixture> {
  const root = await mkdtemp("/tmp/dim-native-automatic-ci-");
  let nativeOrigin = "http://127.0.0.1:1";
  const ordinaryConfig = idleOrdinaryConfig();
  ordinaryConfig.hosts.push({
    hostId: "host-b",
    hostToken: ordinaryHostBToken,
    capacities: [{
      capacity: "backup",
      runnerBaseImage: `registry.example/dim/ordinary-runner@sha256:${"c".repeat(64)}`,
      jobBaseImage: `registry.example/dim/ordinary-job@sha256:${"d".repeat(64)}`,
      bounds: { cpu: "4", memoryBytes: "8589934592", pids: "2048",
        wallClockSeconds: "3600", outputBytes: "16777216" }
    }]
  });
  const transport = createNodeNativeGitAdmissionHttpClient();
  const ordinaryOptions: NativeRootAdmissionServiceOptions = {
    config: parseNativeOrdinaryBundleConfig(ordinaryConfig),
    stateDirectory: join(root, "ordinary"),
    readinessToken: ordinaryReadinessToken,
    activationToken: ordinaryActivationToken,
    expectedGenerationId: generationId,
    proofHttpClient: { request: (input) => transport.request({ ...input, endpoint: nativeOrigin }) }
  };
  let ordinaryServer = await configuredNativeRootAdmissionServer(ordinaryOptions);
  const ordinaryOrigin = await listen(ordinaryServer);
  const ordinaryPort = Number(new URL(ordinaryOrigin).port);
  let ordinaryRunning = true;

  const qemuConfig = schedulerConfig(join(root, "qemu.sqlite3"));
  let authority: NativeQemuAuthorityClient | undefined;
  const forwarding: NativeQemuAuthorityClient = {
    readPolicy(projectId, signal) { return required(authority).readPolicy(projectId, signal); },
    proveEvent(event, signal) { return required(authority).proveEvent(event, signal); },
    issue(claim, capacity, signal) { return required(authority).issue(claim, capacity, signal); },
    candidateLease(claim, attemptId, descriptorDigest, signal) {
      return required(authority).candidateLease(claim, attemptId, descriptorDigest, signal);
    },
    report(claim, event, signal) { return required(authority).report(claim, event, signal); },
    revoke(claim, attemptId, signal) { return required(authority).revoke(claim, attemptId, signal); }
  };
  const qemuServer = configuredNativeQemuSchedulerServer(qemuConfig, forwarding);
  const qemuOrigin = await listen(qemuServer);
  const qemuCi = { endpoint: qemuOrigin, serviceId: "qemu-main" as const,
    query: qemuConfig.credentials.query, eventIntake: qemuConfig.credentials.eventIntake,
    identity: qemuConfig.nativeGit.identity, attemptIssuer: qemuConfig.nativeGit.attemptIssuer,
    candidateReader: qemuConfig.nativeGit.candidateReader, resultReporter: qemuConfig.nativeGit.resultReporter };
  const verifier = createNodeAdmissionVerifierHttpClient();
  const routing: AdmissionVerifierHttpClient = {
    request: (input) => verifier.request({ ...input,
      endpoint: input.endpoint.startsWith("http://ordinary-ci:8080") ? ordinaryOrigin : input.endpoint })
  };
  const native = await nativeBundleReviewFixture("automatic-ci-boundary", undefined,
    authoritativePolicy(["owner"], [], []), undefined, routing, undefined, undefined, { qemuCi });
  nativeOrigin = native.service.origin;
  authority = createNativeQemuAuthorityClient({ ...qemuConfig,
    nativeGit: { ...qemuConfig.nativeGit, endpoint: nativeOrigin } });
  await activateOrdinary(ordinaryOrigin);
  const ordinaryDatabase = join(root, "ordinary", "ordinary-ci.sqlite3");
  await waitFor(() => eventCount(ordinaryDatabase, "native_root_ci_event_receipts") === 1
    && eventCount(qemuConfig.database, "native_qemu_events") === 1,
  () => `ordinary=${eventCount(ordinaryDatabase, "native_root_ci_event_receipts")},qemu=${eventCount(qemuConfig.database, "native_qemu_events")}`);
  return { native, ordinaryOrigin, ordinaryDatabase: join(root, "ordinary", "ordinary-ci.sqlite3"),
    qemuOrigin, qemuDatabase: qemuConfig.database, qemuConfig,
    async stopOrdinary() {
      if (!ordinaryRunning) return;
      await close(ordinaryServer);
      ordinaryRunning = false;
    },
    async startOrdinary() {
      if (ordinaryRunning) return;
      ordinaryServer = await configuredNativeRootAdmissionServer(ordinaryOptions);
      await listen(ordinaryServer, ordinaryPort);
      ordinaryRunning = true;
      await activateOrdinary(ordinaryOrigin);
    },
    async close() {
      await Promise.all([close(ordinaryServer), close(qemuServer)]);
      await rm(root, { recursive: true, force: true });
    } };
}

export function ordinaryHostToken(hostId: "host-a" | "host-b"): string {
  return hostId === "host-a" ? bundleSecrets.host : ordinaryHostBToken;
}

function schedulerConfig(database: string): NativeQemuSchedulerConfig {
  const capacity = { capacity: "kvm-main", runnerBaseImage: `registry.example/runner@sha256:${"1".repeat(64)}`,
    jobBaseImage: `registry.example/job@sha256:${"2".repeat(64)}`, bounds: { cpu: "2", memoryBytes: "1048576",
      pids: "64", wallClockSeconds: "60", outputBytes: "1024" } };
  return { schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1", port: 0, database,
    eligibilityLeaseMilliseconds: 120_000, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://127.0.0.1:1", serviceId: "native-main",
      identity: { username: "qemu-identity", password: token("a") },
      attemptIssuer: { username: "qemu-attempts", password: token("b") },
      candidateReader: { username: "qemu-reader", password: token("c") },
      resultReporter: { username: "qemu-results", password: token("d") } },
    credentials: { eventIntake: { username: "qemu-events", password: token("e") },
      query: { username: "qemu-query", password: token("f") } },
    hosts: [
      { hostId: "qemu-a", hostToken: token("g"), capacities: [capacity] },
      { hostId: "qemu-b", hostToken: token("h"), capacities: [capacity] }
    ] };
}

function token(character: string): string { return Buffer.alloc(32, character).toString("base64url"); }
function required(value: NativeQemuAuthorityClient | undefined): NativeQemuAuthorityClient {
  if (value === undefined) throw new FixtureUnavailableError("QEMU authority is unavailable");
  return value;
}
async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new FixtureUnavailableError("listener is unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
async function activateOrdinary(origin: string): Promise<void> {
  const response = await fetch(`${origin}/v1/activation`, { method: "POST",
    headers: { authorization: `Bearer ${ordinaryActivationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId }) });
  if (response.status !== 200) throw new FixtureUnavailableError("ordinary activation failed");
}
function eventCount(database: string, table: string): number {
  const connection = new DatabaseSync(database, { readOnly: true });
  try { return Number(Reflect.get(connection.prepare(`SELECT count(*) count FROM ${table}`).get() ?? {}, "count")); }
  finally { connection.close(); }
}
async function waitFor(predicate: () => boolean, state: () => string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new FixtureUnavailableError(`automatic CI events were not delivered: ${state()}`);
}
export function qemuRequestId(): string { return randomUUID(); }
class FixtureUnavailableError extends Error { readonly name = "FixtureUnavailableError"; }
