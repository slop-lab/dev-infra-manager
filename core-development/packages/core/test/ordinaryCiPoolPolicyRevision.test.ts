import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ordinaryCiPoolAdmissionId } from "../../../../core/packages/core/src/ordinaryCiPoolAdmission.js";
import {
  configuredOrdinaryCiPoolServer,
  type OrdinaryCiPoolProject,
  type OrdinaryCiPoolServiceConfig
} from "../../../../core/packages/core/src/ordinaryCiPoolService.js";

const OLD_IMAGE = `registry.example/dim/old@sha256:${"a".repeat(64)}`;
const NEW_IMAGE = `registry.example/dim/new@sha256:${"b".repeat(64)}`;
const OLD_PROJECT = {
  projectId: "project-a", projectName: "alpha", organization: "dim-alpha",
  organizationId: 41, webhookToken: "old-webhook-token"
} as const;
const NEW_PROJECT = {
  projectId: "project-a", projectName: "replacement", organization: "dim-replacement",
  organizationId: 51, webhookToken: "new-webhook-token"
} as const;
const roots: string[] = [];
const services: ReturnType<typeof configuredOrdinaryCiPoolServer>[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    service.close();
    await once(service, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI pool operator-policy revisions", () => {
  it("does not dispatch queued demand under a changed Project, image, and label policy", async () => {
    // Given
    const root = await temporaryRoot();
    const database = join(root, "pool.sqlite3");
    const oldEndpoint = await startService(serviceConfig(database, OLD_IMAGE, "old-label", OLD_PROJECT));
    expect((await webhook(oldEndpoint, OLD_PROJECT, "old-label", 100)).status).toBe(202);
    await closeLatestService();
    const newEndpoint = await startService(serviceConfig(database, NEW_IMAGE, "new-label", NEW_PROJECT));

    // When
    const stale = await claim(newEndpoint, "stale-policy");
    const accepted = await webhook(newEndpoint, NEW_PROJECT, "new-label", 200);
    const fresh = await claim(newEndpoint, "fresh-policy");
    const freshBody = responseRecord(await fresh.json());
    await closeLatestService();
    const state = databaseState(database);

    // Then
    expect(stale.status).toBe(204);
    expect(accepted.status).toBe(202);
    expect(fresh.status).toBe(200);
    expect(freshBody).toMatchObject({
      admissionId: ordinaryCiPoolAdmissionId(
        serviceConfig(database, NEW_IMAGE, "new-label", NEW_PROJECT),
        NEW_PROJECT
      ),
      jobId: 200,
      projectId: NEW_PROJECT.projectId,
      projectName: NEW_PROJECT.projectName,
      organization: NEW_PROJECT.organization,
      organizationId: NEW_PROJECT.organizationId,
      jobImage: NEW_IMAGE,
      runnerLabel: "new-label"
    });
    expect(state.queued).toEqual([{
      job_id: 100,
      admission_id: ordinaryCiPoolAdmissionId(
        serviceConfig(database, OLD_IMAGE, "old-label", OLD_PROJECT),
        OLD_PROJECT
      )
    }]);
    expect(state.claims).toEqual([{ job_id: 200, admission_id: freshBody.admissionId }]);
  });

  it("refuses renewal and redispatch when an old-policy claim expires after restart", async () => {
    // Given
    const root = await temporaryRoot();
    const database = join(root, "pool.sqlite3");
    let now = 1_000;
    const lease = { now: () => now, leaseMilliseconds: 100 };
    const oldEndpoint = await startService(serviceConfig(database, OLD_IMAGE, "old-label", OLD_PROJECT), lease);
    await webhook(oldEndpoint, OLD_PROJECT, "old-label", 400);
    const oldClaim = await claim(oldEndpoint, "old-active");
    const oldBody = responseRecord(await oldClaim.json());
    const oldClaimId = textField(oldBody, "claimId");
    await closeLatestService();
    now = 1_050;
    const newEndpoint = await startService(serviceConfig(database, NEW_IMAGE, "new-label", NEW_PROJECT), lease);

    // When
    const accepted = await webhook(newEndpoint, NEW_PROJECT, "new-label", 400);
    const renewal = await renew(newEndpoint, oldClaimId);
    const activeFence = await claim(newEndpoint, "active-after-rotation");
    now = 1_101;
    const expiredFence = await claim(newEndpoint, "expired-after-rotation");
    const fencedBody = responseRecord(await expiredFence.json());
    const expiredClaim = responseRecord(fencedBody.expiredClaim);
    const recovery = await recover(newEndpoint, oldClaimId);
    const replacement = await claim(newEndpoint, "new-policy-replacement");
    const replacementBody = responseRecord(await replacement.json());
    await closeLatestService();
    const state = databaseState(database);

    // Then
    expect(accepted.status).toBe(202);
    expect(renewal.status).toBe(409);
    expect(activeFence.status).toBe(204);
    expect(expiredFence.status).toBe(409);
    expect(expiredClaim).toEqual({
      claimId: oldClaimId,
      projectId: OLD_PROJECT.projectId,
      admissionId: oldBody.admissionId
    });
    expect(recovery.status).toBe(204);
    expect(replacement.status).toBe(200);
    expect(replacementBody).toMatchObject({
      jobId: 400,
      projectName: NEW_PROJECT.projectName,
      jobImage: NEW_IMAGE,
      runnerLabel: "new-label"
    });
    expect(state.queued).toEqual([]);
    expect(state.claims).toEqual([{ job_id: 400, admission_id: replacementBody.admissionId }]);
  });

  it("does not include webhook-token rotation in the public admission identity", () => {
    // Given
    const config = serviceConfig(":memory:", OLD_IMAGE, "old-label", OLD_PROJECT);
    const rotated = { ...OLD_PROJECT, webhookToken: "rotated-private-token" };

    // When
    const originalId = ordinaryCiPoolAdmissionId(config, OLD_PROJECT);
    const rotatedId = ordinaryCiPoolAdmissionId(config, rotated);

    // Then
    expect(rotatedId).toBe(originalId);
    expect(originalId).not.toContain(OLD_PROJECT.webhookToken);
  });

  it("keeps a completed job terminal across an operator-policy revision", async () => {
    // Given
    const root = await temporaryRoot();
    const database = join(root, "pool.sqlite3");
    const oldEndpoint = await startService(serviceConfig(database, OLD_IMAGE, "old-label", OLD_PROJECT));
    expect((await webhook(oldEndpoint, OLD_PROJECT, "old-label", 500)).status).toBe(202);
    expect((await webhook(oldEndpoint, OLD_PROJECT, "old-label", 500, "completed")).status).toBe(202);
    await closeLatestService();
    const newEndpoint = await startService(serviceConfig(database, NEW_IMAGE, "new-label", NEW_PROJECT));

    // When
    const duplicate = await webhook(newEndpoint, NEW_PROJECT, "new-label", 500);
    const dispatched = await claim(newEndpoint, "completed-after-rotation");

    // Then
    expect(duplicate.status).toBe(202);
    expect(dispatched.status).toBe(204);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-ordinary-policy-"));
  roots.push(root);
  return root;
}

function serviceConfig(
  database: string,
  jobImage: string,
  runnerLabel: string,
  project: OrdinaryCiPoolProject
): OrdinaryCiPoolServiceConfig {
  return {
    schemaVersion: 1,
    database,
    jobImage,
    runnerLabel,
    projects: [project],
    hosts: [{ hostId: "host-a", token: "host-a-token", capacities: ["primary"] }]
  };
}

async function startService(
  config: OrdinaryCiPoolServiceConfig,
  lease?: { readonly now: () => number; readonly leaseMilliseconds: number }
): Promise<string> {
  const service = configuredOrdinaryCiPoolServer(config, lease);
  services.push(service);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  return `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
}

async function closeLatestService(): Promise<void> {
  const service = services.pop();
  if (service === undefined) throw new Error("ordinary pool service is missing");
  service.close();
  await once(service, "close");
}

function webhook(
  endpoint: string,
  project: OrdinaryCiPoolProject,
  runnerLabel: string,
  jobId: number,
  action: "queued" | "completed" = "queued"
): Promise<Response> {
  return fetch(`${endpoint}/v1/webhooks/${project.projectId}/workflow-job`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.webhookToken}`,
      "Content-Type": "application/json",
      "X-Gitea-Event": "workflow_job",
      "X-Gitea-Hook-Installation-Target-Type": "organization"
    },
    body: JSON.stringify({
      action,
      workflow_job: { id: jobId, labels: [runnerLabel] },
      organization: { id: project.organizationId, name: project.organization },
      repository: {
        full_name: `${project.organization}/root`,
        owner: { id: project.organizationId, login: project.organization }
      },
      sender: { id: 7, login: "dim-maintainer" }
    })
  });
}

function claim(endpoint: string, requestId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims`, {
    method: "POST",
    headers: {
      Authorization: "Bearer host-a-token",
      "Content-Type": "application/json",
      "X-DIM-Host": "host-a"
    },
    body: JSON.stringify({ hostId: "host-a", capacity: "primary", requestId })
  });
}

function renew(endpoint: string, claimId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims/${claimId}/renew`, {
    method: "POST",
    headers: {
      Authorization: "Bearer host-a-token",
      "Content-Type": "application/json",
      "X-DIM-Host": "host-a"
    },
    body: JSON.stringify({ hostId: "host-a" })
  });
}

function recover(endpoint: string, claimId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims/${claimId}/recover`, {
    method: "POST",
    headers: {
      Authorization: "Bearer host-a-token",
      "Content-Type": "application/json",
      "X-DIM-Host": "host-a"
    },
    body: JSON.stringify({ hostId: "host-a", capacity: "primary" })
  });
}

function databaseState(file: string): {
  readonly queued: readonly unknown[];
  readonly claims: readonly unknown[];
} {
  const database = new DatabaseSync(file, { readOnly: true });
  const state = {
    queued: database.prepare("SELECT job_id, admission_id FROM queued_jobs ORDER BY sequence").all(),
    claims: database.prepare("SELECT job_id, admission_id FROM claims ORDER BY job_id").all()
  };
  database.close();
  return state;
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("expected an HTTP response object");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: Readonly<Record<string, unknown>>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`expected response field '${field}' to be text`);
  return result;
}
