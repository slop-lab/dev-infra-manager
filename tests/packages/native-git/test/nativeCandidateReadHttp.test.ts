import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleSecrets } from "./bundleConfigFixture.js";
import {
  activationTokenB,
  activateFinalizeService,
  cleanupFinalizeFixtures,
  closeFinalizeService,
  createFinalizeRoot,
  generationB,
  generationId,
  importer,
  projectInput,
  startFinalizeService,
  startFinalizeServiceForGeneration
} from "./nativeRootImportFinalizeFixture.js";

const candidateAuthorization = basic("ordinary-candidate-reader", bundleSecrets.candidateReader);
const requestBody = {
  schemaVersion: 1,
  requestId: "00000000-0000-4000-8000-000000000001",
  executionKind: "ordinary-sysbox",
  projectId: "missing-project",
  reviewId: "a".repeat(64),
  jobName: "source",
  attemptId: "00000000-0000-4000-8000-000000000002",
  descriptorDigest: `sha256:${"b".repeat(64)}`,
  hostId: "host-a",
  capacity: "primary"
} as const;

afterEach(cleanupFinalizeFixtures);

describe("installed native candidate-read HTTP boundary", () => {
  it("denies malformed, unknown, wrong-kind, and absent requests before mutation", async () => {
    // Given
    const root = await createFinalizeRoot("candidate-read-denial");
    const service = await startFinalizeService(root);
    const statePath = join(root, "native-idle.sqlite3");
    const before = await readFile(statePath);

    // When
    const malformed = await request(service.origin, "{", candidateAuthorization);
    const unknown = await request(service.origin, JSON.stringify(requestBody), basic("unknown", "unknown"));
    const wrongKind = await request(service.origin, JSON.stringify({ ...requestBody, executionKind: "qemu" }),
      candidateAuthorization);
    const absent = await request(service.origin, JSON.stringify(requestBody), candidateAuthorization);

    // Then
    expect([malformed.status, unknown.status, wrongKind.status, absent.status]).toEqual([400, 401, 403, 404]);
    expect(await readFile(statePath)).toEqual(before);
  });

  it("returns conflict for an unactivated registered Project without mutating state", async () => {
    // Given
    const root = await createFinalizeRoot("candidate-read-inactive");
    const active = await startFinalizeService(root);
    await activateFinalizeService(active.origin);
    await active.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    await closeFinalizeService(active);
    const inactive = await startFinalizeServiceForGeneration(root, generationB, activationTokenB);
    const statePath = join(root, "native-idle.sqlite3");
    const before = await readFile(statePath);

    // When
    const response = await request(inactive.origin,
      JSON.stringify({ ...requestBody, projectId: "project-a" }), candidateAuthorization);

    // Then
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "candidate authority tuple is stale" });
    expect(await readFile(statePath)).toEqual(before);
  });
});

function request(origin: string, body: string, authorization: string): Promise<Response> {
  return fetch(`${origin}/v1/candidate-read-leases`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body
  });
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
