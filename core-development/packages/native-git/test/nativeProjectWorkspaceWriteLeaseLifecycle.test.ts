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
  workspaceWriteIssuerAuthorization,
  type RunningService,
  type WorkspaceWriteLeaseHooks
} from "./nativeRootImportFinalizeFixture.js";

const maximumActiveOperations = 16;
const workspaceId = Buffer.alloc(32, 60).toString("base64url");

afterEach(cleanupFinalizeFixtures);

describe("native Project workspace write lease lifecycle", () => {
  it("shares the sixteen-operation cap with root read lease issuance", async () => {
    // Given
    const barrier = verificationBarrier();
    const fixture = await finalizedFixture("workspace-write-shared-cap", barrier.hooks);
    barrier.enable();
    const writes = Array.from({ length: maximumActiveOperations }, () => requestWriteLease(fixture.origin));
    await barrier.waitForEntries(maximumActiveOperations, writes);

    // When
    const rootRead = await requestRootReadLease(fixture.origin);

    // Then
    expect(rootRead.status).toBe(503);
    barrier.release();
    expect((await Promise.all(writes)).filter((response) => response.status === 201))
      .toHaveLength(maximumActiveOperations);
  });

  it("drains a blocked write proof on close without issuing a lease", async () => {
    // Given
    const barrier = verificationBarrier();
    const fixture = await finalizedFixture("workspace-write-close", barrier.hooks);
    barrier.enable();
    const request = requestWriteLease(fixture.origin).then(
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

    // Then
    expect((await request).kind).toBe("closed");
  });
});

async function finalizedFixture(
  label: string,
  hooks: WorkspaceWriteLeaseHooks
): Promise<{ readonly service: RunningService; readonly origin: string }> {
  const root = await createFinalizeRoot(label);
  const bundle = await createRootBundle();
  const service = await startFinalizeService(root, undefined, undefined, undefined, hooks);
  await activateFinalizeService(service.origin);
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
  const receipt = parseImportReceipt(await (await uploadRootBundle(service.origin, bundle)).json());
  expect((await finalizeRootImport(service.origin, {
    schemaVersion: 1, generationId, importNonce: receipt.importNonce, bundleDigest: receipt.bundleDigest
  })).status).toBe(200);
  return { service, origin: service.origin };
}

function requestWriteLease(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/workspace-write-leases`, {
    method: "POST",
    headers: { authorization: workspaceWriteIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId, repositoryId: "root", workspaceId })
  });
}

function requestRootReadLease(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/root-read-leases`, {
    method: "POST",
    headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
}

function verificationBarrier(): VerificationBarrier {
  let enabled = false;
  let active = 0;
  let releaseVerification: (() => void) | undefined;
  const verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const entryWaiters: Array<() => void> = [];
  const hooks: WorkspaceWriteLeaseHooks = {
    async beforeVerification() {
      if (!enabled) return;
      active += 1;
      entryWaiters.splice(0).forEach((resolve) => resolve());
      await verificationReleased;
      active -= 1;
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
    }
  };
}

type VerificationBarrier = {
  readonly hooks: WorkspaceWriteLeaseHooks;
  enable(): void;
  waitForEntry(operation: Promise<unknown>): Promise<void>;
  waitForEntries(count: number, operations: readonly Promise<unknown>[]): Promise<void>;
  release(): void;
};

class TestSetupError extends Error {
  readonly name = "TestSetupError";
}
