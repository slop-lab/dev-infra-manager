import { strict as assert } from "node:assert";
import { open, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { percentileSummary } from "./native-history-metrics.js";
import type { NativeHistoryCorpusDescriptor } from "./native-history-corpus.js";
import { seedRetainedHistoryIntents } from "./native-history-intents.js";
import { verifyRetainedHistoryIntents, type RetainedIntentHistoryDescriptor } from "./native-history-intent-verification.js";
import { deliveryIntentKey } from "../../../packages/control-plane/plugins/git-ci/src/delivery-intent-record.js";

type DeliveryStoreModule = typeof import("../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.js");
type BindingModule = typeof import("../../../packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.js");
type PlanStoreModule = typeof import("../../../packages/control-plane/plugins/git-ci/src/plan-store.js");
type FixtureModule = typeof import("../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js");

type MeasurementInput = {
  readonly sourceTree: string;
  readonly repository: string;
  readonly descriptor: NativeHistoryCorpusDescriptor;
  readonly retainedIntentHistory?: true;
};

type IdentityEvidence = {
  readonly count: number;
  readonly failures: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
  readonly maxMilliseconds: number;
  readonly errors: readonly string[];
};

const warmSampleCount = 5;
const pollIntervalMilliseconds = 1_000;
const identityCadenceMilliseconds = 100;
const requestDeadlineMilliseconds = 5_000;

export async function measureNativeHistory(input: MeasurementInput): Promise<object> {
  const sourceTree = resolve(input.sourceTree);
  const counter = await installBodyReadCounter();
  const deliveryStore: DeliveryStoreModule = await sourceImport(sourceTree,
    "packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-store.ts");
  const bindingApi: BindingModule = await sourceImport(sourceTree,
    "packages/control-plane/plugins/git-ci/src/authoritative-native-delivery-binding.ts");
  const planStore: PlanStoreModule = await sourceImport(sourceTree,
    "packages/control-plane/plugins/git-ci/src/plan-store.ts");
  const fixture: FixtureModule = await sourceImport(sourceTree,
    "tests/control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.ts");
  const binding = bindingApi.authoritativeNativeDeliveryBinding("ci", "http://execution:8080/v1/jobs");
  const transientDirectory = join(input.repository, "dim-git-ci-deliveries");
  const serviceRoot = await fixture.createFinalizeRoot("native-history-identity");
  const service = await fixture.startFinalizeService(serviceRoot);
  try {
    await rm(transientDirectory, { recursive: true, force: true });
    let retainedIntents: RetainedIntentHistoryDescriptor | undefined;
    if (input.retainedIntentHistory === true) {
      const envelope = await planStore.readAuthoritativeNativeReviewEnvelope(input.repository, input.descriptor.activeReviewId);
      assert.ok(envelope, "retained-intent fixture is missing its canonical CI projection");
      retainedIntents = await seedRetainedHistoryIntents({ repository: input.repository, envelope,
        binding, generationId: fixture.generationId });
    }
    const idle = await phase({ expectedPending: 0, repository: input.repository, serviceOrigin: service.origin,
      authorization: fixture.workspaceWriteIssuerAuthorization, binding, generationId: fixture.generationId,
      readPending: deliveryStore.readPendingAuthoritativeNativeDeliveries, counter });
    const activeEnvelope = await planStore.readAuthoritativeNativeReviewEnvelope(
      input.repository, input.descriptor.activeReviewId
    );
    assert.ok(activeEnvelope, "active synthetic review is missing its CI projection");
    await deliveryStore.recordExplicitAuthoritativeNativeDeliveryIntent(
      input.repository, activeEnvelope, fixture.generationId, binding, "native-history-latency-active"
    );
    const active = await phase({ expectedPending: 1, repository: input.repository, serviceOrigin: service.origin,
      authorization: fixture.workspaceWriteIssuerAuthorization, binding, generationId: fixture.generationId,
      readPending: deliveryStore.readPendingAuthoritativeNativeDeliveries, counter });
    if (retainedIntents !== undefined) {
      const addedNames = activeEnvelope.events.map(({ eventId }) => `${deliveryIntentKey({ eventId,
        generationId: fixture.generationId, serviceId: binding.serviceId, destinationDigest: binding.destinationDigest })}.json`);
      retainedIntents = await verifyRetainedHistoryIntents(join(transientDirectory, "intents"), retainedIntents, addedNames);
    }
    return {
      schemaVersion: 1,
      sourceTree,
      node: process.version,
      syntheticStorageFixture: true,
      gitPromotionProof: false,
      corpus: input.descriptor,
      ...(retainedIntents === undefined ? {} : { retainedIntents }),
      controls: { warmSampleCount, pollIntervalMilliseconds, identityCadenceMilliseconds,
        requestDeadlineMilliseconds, maximumInflightIdentityRequests: 1, retainedIntentCount: retainedIntents?.recordCount ?? 0 },
      idle,
      active,
      bodyReadScope: "unattributed main-thread FileHandle.readFile return bytes during each measured phase; worker and native off-thread reads are not observed",
      cleanup: { corpusRetained: true, removedTransientDirectory: "repository/dim-git-ci-deliveries",
        removedServiceFixture: true, credentialsReported: false, responseBodiesReported: false }
    };
  } finally {
    await rm(transientDirectory, { recursive: true, force: true });
    await fixture.cleanupFinalizeFixtures();
    counter.restore();
  }
}

type PhaseInput = {
  readonly expectedPending: number;
  readonly repository: string;
  readonly serviceOrigin: string;
  readonly authorization: string;
  readonly binding: Parameters<DeliveryStoreModule["readPendingAuthoritativeNativeDeliveries"]>[2];
  readonly generationId: string;
  readonly readPending: DeliveryStoreModule["readPendingAuthoritativeNativeDeliveries"];
  readonly counter: BodyReadCounter;
};

async function phase(input: PhaseInput): Promise<object> {
  input.counter.reset();
  const identity = startIdentityProbe(input.serviceOrigin, input.authorization);
  await identity.ready;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const cpuStart = process.cpuUsage();
  const samples: number[] = [];
  let coldBodyReadBytes = 0;
  let completed = false;
  try {
    for (let index = 0; index <= warmSampleCount; index += 1) {
      const started = performance.now();
      const pending = await input.readPending(input.repository, 1, input.binding, input.generationId);
      samples.push(round(performance.now() - started));
      assert.equal(pending.length, input.expectedPending);
      if (index === 0) coldBodyReadBytes = input.counter.bytes();
      await delay(pollIntervalMilliseconds);
    }
    completed = true;
  } finally {
    eventLoop.disable();
    if (!completed) await identity.stop();
  }
  const cpu = process.cpuUsage(cpuStart);
  const identityEvidence = await identity.stop();
  const cold = samples[0];
  assert.ok(cold !== undefined);
  return {
    pendingCount: input.expectedPending,
    lookup: { coldMilliseconds: cold, warm: percentileSummary(samples.slice(1)), samplesMilliseconds: samples },
    cpu: { userMilliseconds: round(cpu.user / 1_000), systemMilliseconds: round(cpu.system / 1_000) },
    eventLoop: { count: eventLoop.count, p50Milliseconds: round(eventLoop.percentile(50) / 1e6),
      p95Milliseconds: round(eventLoop.percentile(95) / 1e6), maxMilliseconds: round(eventLoop.max / 1e6) },
    identity: identityEvidence,
    bodyReadBytes: input.counter.bytes(),
    coldBodyReadBytes,
    warmBodyReadBytes: input.counter.bytes() - coldBodyReadBytes
  };
}

function startIdentityProbe(endpoint: string, authorization: string): {
  readonly ready: Promise<void>;
  readonly stop: () => Promise<IdentityEvidence>;
} {
  const worker = new Worker(new URL("./native-history-http-worker.ts", import.meta.url), {
    workerData: { endpoint, authorization, cadenceMilliseconds: identityCadenceMilliseconds,
      deadlineMilliseconds: requestDeadlineMilliseconds }
  });
  const samples: number[] = [];
  const errors: string[] = [];
  let failures = 0;
  let resolveReady: (() => void) | undefined;
  let resolveStopped: (() => void) | undefined;
  const ready = new Promise<void>((resolvePromise) => { resolveReady = resolvePromise; });
  const stopped = new Promise<void>((resolvePromise) => { resolveStopped = resolvePromise; });
  worker.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const kind = Reflect.get(message, "kind");
    if (kind === "ready") resolveReady?.();
    else if (kind === "stopped") resolveStopped?.();
    else if (kind === "sample") {
      const milliseconds = Reflect.get(message, "milliseconds");
      const statusCode = Reflect.get(message, "statusCode");
      if (typeof milliseconds === "number" && statusCode === 200) samples.push(round(milliseconds));
      else failures += 1;
    } else if (kind === "failure") {
      failures += 1;
      const messageText = Reflect.get(message, "message");
      if (typeof messageText === "string" && errors.length < 5) errors.push(messageText.slice(0, 200));
    }
  });
  worker.once("error", (error) => {
    failures += 1;
    if (errors.length < 5) errors.push(`${error.name}: ${error.message}`.slice(0, 200));
    resolveReady?.();
    resolveStopped?.();
  });
  return { ready, stop: async () => {
    worker.postMessage("stop");
    await Promise.race([stopped, delay(requestDeadlineMilliseconds + 1_000)]);
    await worker.terminate();
    const sorted = [...samples].sort((left, right) => left - right);
    return { count: sorted.length, failures, p50Milliseconds: rank(sorted, 0.5),
      p95Milliseconds: rank(sorted, 0.95), p99Milliseconds: rank(sorted, 0.99),
      maxMilliseconds: sorted[sorted.length - 1] ?? 0, errors };
  } };
}

type BodyReadCounter = { readonly bytes: () => number; readonly reset: () => void; readonly restore: () => void };
async function installBodyReadCounter(): Promise<BodyReadCounter> {
  const handle = await open("/dev/null", "r");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = Reflect.get(prototype, "readFile");
  if (typeof original !== "function") throw new NativeHistoryMeasureError("FileHandle.readFile is unavailable");
  let bytes = 0;
  Reflect.set(prototype, "readFile", async function(this: object, ...args: readonly unknown[]): Promise<unknown> {
    const value = await Reflect.apply(original, this, args);
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    else if (Buffer.isBuffer(value)) bytes += value.length;
    return value;
  });
  syncBuiltinESMExports();
  return { bytes: () => bytes, reset: () => { bytes = 0; }, restore: () => {
    Reflect.set(prototype, "readFile", original);
    syncBuiltinESMExports();
  } };
}

async function sourceImport<Module>(sourceTree: string, path: string): Promise<Module> {
  return import(pathToFileURL(resolve(sourceTree, path)).href);
}
function rank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.ceil(sorted.length * percentile) - 1] ?? 0;
}
function round(value: number): number { return Math.round(value * 1_000) / 1_000; }

class NativeHistoryMeasureError extends Error {
  readonly name = "NativeHistoryMeasureError";
}
