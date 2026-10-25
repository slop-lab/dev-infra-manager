import { setTimeout as delay } from "node:timers/promises";
import { dimWorkflowCompiler } from "@slop-lab/dim-control-plane-plugin-ci-workflows";
import { parseManagedGitServiceConfig } from "@slop-lab/dim-control-plane-admin/service-pair";
import { parseNativeGitProjectAttachment } from "@slop-lab/dim-contracts-git";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeProjectAttachmentHooks } from "../../../../packages/control-plane/plugins/git-repositories/src/native-project-attachment-http.js";
import { configuredManagedGitFixture, type ManagedGitFixture } from "../../../support/managed-git-service.js";
import { gitPolicy } from "../../../support/git-policy.js";
import { bundleSecrets, idleNativeConfig } from "./bundleConfigFixture.js";
import {
  activateFinalizeService,
  authorization,
  cleanupFinalizeFixtures,
  createFinalizeRoot,
  createRootBundle,
  finalizeRootImport,
  foreignHostPromoter,
  foreignHumanReviewer,
  generationId,
  hostPromoter,
  humanReviewer,
  importer,
  parseImportReceipt,
  projectInput,
  rootReadIssuer,
  rootReadIssuerAuthorization,
  startFinalizeService,
  uploadRootBundle,
  workspaceWriteIssuer,
  wrongHostRootReadIssuer,
  type RunningService
} from "./nativeRootImportFinalizeFixture.js";

const services: ManagedGitFixture[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await cleanupFinalizeFixtures();
});

describe("native Project attachment operation lifecycle", () => {
  it("returns busy when the shared read-operation capacity is exhausted", async () => {
    // Given
    let entered = 0;
    let admitAll: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { admitAll = resolve; });
    let capacityReached: (() => void) | undefined;
    const full = new Promise<void>((resolve) => { capacityReached = resolve; });
    const root = await createFinalizeRoot("attachment-capacity");
    const service = await startFinalizeService(root, undefined, {
      async beforeVerification() {
        entered += 1;
        if (entered === 16) capacityReached?.();
        await held;
      }
    });
    await activateFinalizeService(service.origin);
    await importRepository(service);
    const leases = Array.from({ length: 16 }, () => requestReadLease(service.origin));
    await full;

    // When
    const response = await discovery(service.origin);

    // Then
    expect(response.status).toBe(503);
    admitAll?.();
    expect((await Promise.all(leases)).every((lease) => lease.status === 201)).toBe(true);
  });

  it("releases aborted descriptor operations without blocking repository mutations", async () => {
    // Given
    let block = true;
    let entered: (() => void) | undefined;
    const hooks: NativeProjectAttachmentHooks = {
      beforeVerification(signal) {
        entered?.();
        if (!block) return Promise.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    };
    const root = await createFinalizeRoot("attachment-abort");
    const service = await startHookedService(root, hooks);
    await activateFinalizeService(service.origin);
    await importRepository(service);

    // When
    for (let index = 0; index < 16; index += 1) {
      const controller = new AbortController();
      const hookEntered = new Promise<void>((resolve) => { entered = resolve; });
      const request = discovery(service.origin, controller.signal);
      await hookEntered;
      if (index === 0) {
        await Promise.race([
          service.prepareProject(generationId, importer.hostId, projectInput("project-b")),
          delay(2_000).then(() => Promise.reject(new Error("repository mutation was blocked by attachment proof")))
        ]);
      }
      controller.abort();
      await Promise.allSettled([request]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    block = false;
    const recovered = await discovery(service.origin);

    // Then
    expect(recovered.status).toBe(200);
  });

  it("rejects a descriptor when the completed repository set changes during proof", async () => {
    // Given
    let verificationFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => { verificationFinished = resolve; });
    let recheck: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { recheck = resolve; });
    const root = await createFinalizeRoot("attachment-set-change");
    const service = await startHookedService(root, {
      async afterVerification() {
        verificationFinished?.();
        await held;
      }
    });
    await activateFinalizeService(service.origin);
    await importRepository(service);
    const descriptor = discovery(service.origin);
    await finished;

    // When
    await importRepository(service, "other");
    recheck?.();
    const response = await descriptor;

    // Then
    expect(response.status).toBe(409);
  });

  it("allows a delayed complete proof beyond thirty seconds for a multi-repository attachment", async () => {
    // Given
    let verificationStarted = false;
    const root = await createFinalizeRoot("attachment-delayed-proof");
    const service = await startHookedService(root, {
      async beforeVerification(signal) {
        verificationStarted = true;
        await delay(30_200, undefined, { signal });
      }
    });
    await activateFinalizeService(service.origin);
    await importRepository(service);
    await importRepository(service, "other");

    // When
    const started = performance.now();
    const response = await discovery(service.origin);
    const elapsed = performance.now() - started;

    // Then
    expect(verificationStarted).toBe(true);
    expect(response.status).toBe(200);
    const attachment = parseNativeGitProjectAttachment(await response.json());
    expect(attachment.repositories.map(({ repositoryId }) => repositoryId).sort()).toEqual(["other", "root"]);
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(elapsed).toBeLessThan(35_000);
  }, 40_000);

  it("retains read capacity for aborted snapshot checks until the mutation queue drains", async () => {
    // Given
    let admitted = 0, verified = 0, aborted = 0;
    let proofReady: (() => void) | undefined, allAborted: (() => void) | undefined;
    const proofs = new Promise<void>((resolve) => { proofReady = resolve; });
    const cancellations = new Promise<void>((resolve) => { allAborted = resolve; });
    const root = await createFinalizeRoot("attachment-queued-abort");
    const service = await startHookedService(root, {
      async beforeVerification() { admitted += 1; },
      async afterVerification(signal) {
        signal.addEventListener("abort", () => { if (++aborted === 16) allAborted?.(); }, { once: true });
        if (++verified === 16) proofReady?.();
      }
    });
    await activateFinalizeService(service.origin);
    await importRepository(service);
    let drain: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { drain = resolve; });
    const mutation = service.context.serialize(() => held);
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const requests = controllers.map((controller) => discovery(service.origin, controller.signal));
    const settled = Promise.allSettled(requests);
    try {
      await proofs;
      await new Promise<void>((resolve) => setImmediate(resolve));

      // When
      for (const controller of controllers) controller.abort();
      await cancellations;
      await settled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const response = await discovery(service.origin);

      // Then
      expect(response.status).toBe(503);
      expect(admitted).toBe(16);
    } finally {
      drain?.();
      await mutation;
    }
    await service.context.serialize(async () => {});
    expect((await discovery(service.origin)).status).toBe(200);
  });
});

async function startHookedService(root: string, hooks: NativeProjectAttachmentHooks): Promise<RunningService> {
  const service = await configuredManagedGitFixture({
    workflowCompiler: dimWorkflowCompiler,
    config: parseManagedGitServiceConfig({
      ...idleNativeConfig(),
      projectRegistrars: [{ hostId: "host-a", username: "registrar-a", password: bundleSecrets.projectRegistrar }],
      projectRootImporters: [importer],
      projectRootReadIssuers: [rootReadIssuer, wrongHostRootReadIssuer],
      workspaceWriteIssuers: [workspaceWriteIssuer],
      humanReviewers: [humanReviewer, foreignHumanReviewer],
      hostPromoters: [hostPromoter, foreignHostPromoter]
    }),
    stateDirectory: root,
    readinessToken: Buffer.alloc(32, 41).toString("base64url"),
    activationToken: Buffer.alloc(32, 42).toString("base64url"),
    expectedGenerationId: generationId,
    projectAttachmentHooks: hooks
  });
  services.push(service);
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", () => {
      service.server.off("error", reject);
      resolve();
    });
  });
  const address = service.server.address();
  if (address === null || typeof address === "string") throw new Error("native Git listener is unavailable");
  return { ...service, origin: `http://127.0.0.1:${String(address.port)}` };
}

async function importRepository(service: RunningService, repositoryId = "root"): Promise<void> {
  const bundle = await createRootBundle({ [`${repositoryId}.txt`]: `${repositoryId}\n` });
  await service.prepareProject(generationId, importer.hostId, projectInput("project-a", repositoryId));
  const receipt = parseImportReceipt(await (
    await uploadRootBundle(service.origin, bundle, gitPolicy({}), repositoryId)
  ).json());
  const finalized = await finalizeRootImport(service.origin, {
    schemaVersion: 1,
    generationId,
    importNonce: receipt.importNonce,
    bundleDigest: receipt.bundleDigest
  }, authorization, repositoryId);
  expect(finalized.status).toBe(200);
}

function discovery(origin: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/attachment`, {
    headers: { authorization: rootReadIssuerAuthorization, "x-dim-generation-id": generationId },
    ...(signal === undefined ? {} : { signal })
  });
}

function requestReadLease(origin: string): Promise<Response> {
  return fetch(`${origin}/v1/projects/project-a/repositories/root/read-leases`, {
    method: "POST",
    headers: { authorization: rootReadIssuerAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId })
  });
}
