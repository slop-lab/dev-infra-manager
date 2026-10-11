import { afterEach, describe, expect, it } from "vitest";
import {
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  generationId,
  importer,
  parseImportReceipt,
  projectInput,
  rootReadIssuerAuthorization,
  startFinalizeService,
  uploadRootBundle,
  type RootReadLeaseHooks,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

const maximumLiveLeases = 16;

afterEach(cleanupFinalizeFixtures);

describe("native Project root read lease lifecycle", () => {
  it("caps live leases and reaps expired records before issuing another", async () => {
    // Given
    let now = 1_000;
    const fixture = await finalizedFixture("root-read-lease-cap", () => now);
    const leases = await Promise.all(Array.from({ length: maximumLiveLeases }, () => issueLease(fixture.service.origin)));

    // When
    const capped = await requestLease(fixture.service.origin);
    now = leases[0]?.expiresAt ?? now;
    const reaped = await requestLease(fixture.service.origin);

    // Then
    expect(capped.status).toBe(503);
    expect(reaped.status).toBe(201);
  });

  it("rejects a lease that expires while live-root verification is blocked", async () => {
    // Given
    let now = 1_000;
    const barrier = verificationBarrier();
    const fixture = await finalizedFixture("root-read-expiry-during-proof", () => now, barrier.hooks);
    const lease = await issueLease(fixture.service.origin);
    barrier.enable();

    // When
    const responsePromise = uploadPackDiscovery(fixture.service.origin, lease);
    await barrier.waitForEntry(responsePromise);
    now = lease.expiresAt;
    barrier.release();
    const response = await responsePromise;

    // Then
    expect(response.status).toBe(401);
    expect(barrier.backendStarts()).toBe(0);
  });

  it("admits at most sixteen concurrent lease-issuance proofs", async () => {
    // Given
    const barrier = verificationBarrier();
    const fixture = await finalizedFixture("root-read-issuance-operation-cap", undefined, barrier.hooks);
    barrier.enable();

    // When
    const requests = Array.from({ length: maximumLiveLeases + 1 }, () => requestLease(fixture.service.origin));
    await barrier.waitForEntries(maximumLiveLeases, requests);
    const rejected = await busyResponse(requests);

    // Then
    expect(rejected.status).toBe(503);
    expect(barrier.maximumConcurrent()).toBe(maximumLiveLeases);
    barrier.release();
    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(maximumLiveLeases);
  });

  it("admits at most sixteen concurrent verification and backend operations", async () => {
    // Given
    const barrier = verificationBarrier();
    const fixture = await finalizedFixture("root-read-operation-cap", undefined, barrier.hooks);
    const lease = await issueLease(fixture.service.origin);
    barrier.enable();

    // When
    const requests = Array.from({ length: maximumLiveLeases + 1 }, () => uploadPackDiscovery(fixture.service.origin, lease));
    await barrier.waitForEntries(maximumLiveLeases, requests);
    const rejected = await busyResponse(requests);

    // Then
    expect(rejected.status).toBe(503);
    expect(barrier.maximumConcurrent()).toBe(maximumLiveLeases);
    barrier.release();
    const responses = await Promise.all(requests);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(maximumLiveLeases);
    expect(barrier.backendStarts()).toBe(maximumLiveLeases);
  });

  it("drains a blocked read proof on close without spawning Git or sending a response", async () => {
    // Given
    const barrier = verificationBarrier();
    const fixture = await finalizedFixture("root-read-close-proof", undefined, barrier.hooks);
    const lease = await issueLease(fixture.service.origin);
    barrier.enable();
    const request = uploadPackDiscovery(fixture.service.origin, lease).then(
      (response) => ({ kind: "response" as const, status: response.status }),
      () => ({ kind: "closed" as const })
    );
    await barrier.waitForEntry(request);

    // When
    const closing = closeFinalizeService(fixture.service);
    expect(await Promise.race([closing.then(() => "closed" as const), Promise.resolve("pending" as const)]))
      .toBe("pending");
    barrier.release();
    await closing;
    const result = await request;

    // Then
    expect(result.kind).toBe("closed");
    expect(barrier.backendStarts()).toBe(0);
  });
});

async function finalizedFixture(
  label: string,
  clock?: () => number,
  hooks?: RootReadLeaseHooks
): Promise<{ readonly service: RunningService }> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root, clock, hooks);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { service };
}

async function issueLease(origin: string): Promise<RootReadLease> {
  const response = await requestLease(origin);
  expect(response.status).toBe(201);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TestSetupError();
  const username = Reflect.get(value, "username");
  const password = Reflect.get(value, "password");
  const expiresAt = Reflect.get(value, "expiresAt");
  if (typeof username !== "string" || typeof password !== "string" || typeof expiresAt !== "number") {
    throw new TestSetupError();
  }
  return { username, password, expiresAt };
}

function requestLease(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/root-read-leases`, {
    method: "POST",
    headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
}

function uploadPackDiscovery(origin: string, lease: RootReadLease): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: basic(lease.username, lease.password) }
  });
}

function busyResponse(requests: readonly Promise<Response>[]): Promise<Response> {
  return Promise.race(requests.map(async (request) => {
    const response = await request;
    if (response.status === 503) return response;
    return new Promise<Response>(() => undefined);
  }));
}

function verificationBarrier(): VerificationBarrier {
  let enabled = false;
  let active = 0;
  let maximum = 0;
  let backendStarts = 0;
  let releaseVerification: (() => void) | undefined;
  let verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const entryWaiters: Array<() => void> = [];
  const hooks: RootReadLeaseHooks = {
    async beforeVerification() {
      if (!enabled) return;
      active += 1;
      maximum = Math.max(maximum, active);
      entryWaiters.splice(0).forEach((resolve) => resolve());
      await verificationReleased;
      active -= 1;
    },
    backendStarted() {
      backendStarts += 1;
    }
  };
  return {
    hooks,
    enable() {
      enabled = true;
    },
    async waitForEntry(operation) {
      if (active > 0) return;
      const reached = new Promise<void>((resolve) => { entryWaiters.push(resolve); });
      await Promise.race([reached, operation.then(() => { throw new TestSetupError(); })]);
    },
    async waitForEntries(count, operations) {
      while (active < count) {
        const reached = new Promise<void>((resolve) => { entryWaiters.push(resolve); });
        await Promise.race([reached, Promise.all(operations).then(() => { throw new TestSetupError(); })]);
      }
    },
    release() {
      enabled = false;
      releaseVerification?.();
      verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
    },
    maximumConcurrent: () => maximum,
    backendStarts: () => backendStarts
  };
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

type RootReadLease = { readonly username: string; readonly password: string; readonly expiresAt: number };
type VerificationBarrier = {
  readonly hooks: RootReadLeaseHooks;
  enable(): void;
  waitForEntry(operation: Promise<unknown>): Promise<void>;
  waitForEntries(count: number, operations: readonly Promise<unknown>[]): Promise<void>;
  release(): void;
  maximumConcurrent(): number;
  backendStarts(): number;
};

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
