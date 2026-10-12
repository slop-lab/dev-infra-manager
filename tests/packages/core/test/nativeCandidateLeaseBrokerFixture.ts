import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createNativeQemuAuthorityClient, type NativeQemuAuthorityClient }
  from "../../../../core/packages/core/src/nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerConfig } from "../../../../core/packages/core/src/nativeQemuSchedulerConfig.js";
import { NativeQemuHostClient } from "../../../../core/packages/core/src/nativeQemuHostClient.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/core/src/nativeQemuSchedulerService.js";
import { authoritativePolicy } from "../../native-git/test/authoritativeNativeCandidateFixture.js";
import { createBundleReview, nativeBundleReviewFixture, type NativeBundleReviewFixture }
  from "../../native-git/test/nativeBundleReviewFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");

export type QemuBrokerFixture = {
  readonly root: string;
  readonly native: NativeBundleReviewFixture;
  readonly scheduler: Server;
  readonly schedulerOrigin: string;
  readonly config: NativeQemuSchedulerConfig;
  readonly host: NativeQemuHostClient;
  readonly foreignHost: NativeQemuHostClient;
  readonly now: { value: number };
  close(): Promise<void>;
};

export async function qemuBrokerFixture(): Promise<QemuBrokerFixture> {
  const root = await mkdtemp("/tmp/dim-native-qemu-broker-");
  const config = schedulerConfig(join(root, "qemu.sqlite3"));
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
  const scheduler = configuredNativeQemuSchedulerServer(config, forwarding);
  await new Promise<void>((resolve) => scheduler.listen(0, "127.0.0.1", resolve));
  const schedulerOrigin = origin(scheduler);
  const now = { value: Date.now() };
  const qemuCi = { endpoint: schedulerOrigin, serviceId: "qemu-main" as const,
    query: config.credentials.query, eventIntake: config.credentials.eventIntake,
    identity: config.nativeGit.identity, attemptIssuer: config.nativeGit.attemptIssuer,
    candidateReader: config.nativeGit.candidateReader, resultReporter: config.nativeGit.resultReporter };
  const native = await nativeBundleReviewFixture("candidate-lease-qemu", undefined,
    authoritativePolicy(["owner"], [], [
      { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" }
    ]), undefined, undefined, undefined, undefined, { qemuCi }, undefined, qemuOnlyRunner(), () => now.value);
  authority = createNativeQemuAuthorityClient({ ...config,
    nativeGit: { ...config.nativeGit, endpoint: native.service.origin } });
  await createBundleReview(native.service);
  await waitFor(() => eventCount(config.database) === 1);
  const [first, second] = config.hosts;
  if (first === undefined || second === undefined) throw new TypeError("QEMU hosts are missing");
  return {
    root,
    native,
    scheduler,
    schedulerOrigin,
    config,
    host: new NativeQemuHostClient(connection(first.hostId, first.hostToken, schedulerOrigin, native.service.origin), "kvm-main"),
    foreignHost: new NativeQemuHostClient(connection(second.hostId, second.hostToken, schedulerOrigin, native.service.origin), "kvm-foreign"),
    now,
    async close() {
      if (scheduler.listening) await new Promise<void>((resolve) => scheduler.close(() => resolve()));
      await native.service.close();
      await Promise.all([rm(native.root, { recursive: true, force: true }),
        rm(native.clone, { recursive: true, force: true })]);
      await rm(root, { recursive: true, force: true });
    }
  };
}

function schedulerConfig(database: string): NativeQemuSchedulerConfig {
  const capacity = (capacity: string) => ({ capacity,
    runnerBaseImage: `registry.example/runner@sha256:${"1".repeat(64)}`,
    jobBaseImage: `registry.example/job@sha256:${"2".repeat(64)}`,
    bounds: { cpu: "2", memoryBytes: "1048576", pids: "64", wallClockSeconds: "60", outputBytes: "1024" } });
  return { schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1", port: 0, database,
    eligibilityLeaseMilliseconds: 120_000, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://127.0.0.1:1", serviceId: "native-main",
      identity: { username: "qemu-identity", password: token("a") },
      attemptIssuer: { username: "qemu-attempts", password: token("b") },
      candidateReader: { username: "qemu-reader", password: token("c") },
      resultReporter: { username: "qemu-results", password: token("d") } },
    credentials: { eventIntake: { username: "qemu-events", password: token("e") },
      query: { username: "qemu-query", password: token("g") } },
    hosts: [{ hostId: "worker-qemu", hostToken: token("h"), capacities: [capacity("kvm-main")] },
      { hostId: "foreign-qemu", hostToken: token("i"), capacities: [capacity("kvm-foreign")] }] };
}

function connection(hostId: string, hostToken: string, scheduler: string, nativeGit: string) {
  return { schemaVersion: 1 as const, hostId, generationId, gitExecutable: "/usr/bin/git",
    scheduler: { transport: "loopback-http" as const, endpoint: scheduler, serviceId: "qemu-main" as const, hostToken },
    nativeGit: { transport: "loopback-http" as const, endpoint: nativeGit, serviceId: "native-main" as const },
    capacities: [{ capacity: hostId === "worker-qemu" ? "kvm-main" : "kvm-foreign",
      runnerBaseImage: `registry.example/runner@sha256:${"1".repeat(64)}`,
      jobBaseImage: `registry.example/job@sha256:${"2".repeat(64)}`, cpus: 2, memoryBytes: 1048576,
      pids: 64, timeoutSeconds: 60, outputBytes: 1024 }] };
}
function qemuOnlyRunner(): string {
  return "schemaVersion: 4\nordinary:\n  jobs: {}\nqemu:\n  jobs:\n    integration:\n      script: .dim/ci/jobs/integration.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n";
}
function required(value: NativeQemuAuthorityClient | undefined): NativeQemuAuthorityClient {
  if (value === undefined) throw new TypeError("QEMU authority is unavailable"); return value;
}
function origin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("QEMU listener is unavailable");
  return `http://127.0.0.1:${address.port}`;
}
function authorization(credential: { readonly username: string; readonly password: string }): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}
function post(url: string, body: object, authorizationHeader: string): Promise<Response> {
  return fetch(url, { method: "POST", headers: { authorization: authorizationHeader,
    "content-type": "application/json" }, body: JSON.stringify(body) });
}
function eventCount(database: string): number {
  const connection = new DatabaseSync(database, { readOnly: true });
  try { return Number(connection.prepare("SELECT count(*) count FROM native_qemu_events").get()?.count); }
  finally { connection.close(); }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("QEMU broker condition was not reached");
}
