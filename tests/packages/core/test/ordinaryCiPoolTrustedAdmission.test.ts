import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredOrdinaryCiPoolServer,
  type OrdinaryCiPoolServiceConfig
} from "../../../../core/packages/core/src/ordinaryCiPoolService.js";

const IMAGE = `registry.example/dim/common@sha256:${"a".repeat(64)}`;
const services: ReturnType<typeof configuredOrdinaryCiPoolServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    service.close();
    await once(service, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted ordinary CI Project admission", () => {
  it("admits two reviewed Projects through the registrar and dispatches their jobs", async () => {
    // Given
    const endpoint = await startService();
    const alpha = await admit(endpoint, admission("project-a", "alpha", 41, "1".repeat(40)));
    const beta = await admit(endpoint, admission("project-b", "beta", 42, "2".repeat(40)));

    // When
    const alphaQueued = await webhook(endpoint, "project-a", token(alpha), 101, "dim-alpha");
    const betaQueued = await webhook(endpoint, "project-b", token(beta), 202, "dim-beta");
    const first = await claim(endpoint, "host-a", "request-a");
    const second = await claim(endpoint, "host-b", "request-b");

    // Then
    expect([alphaQueued.status, betaQueued.status, first.status, second.status]).toEqual([202, 202, 200, 200]);
    const claims = [record(await first.json()), record(await second.json())];
    expect(new Set(claims.map((claim) => claim.projectId))).toEqual(new Set(["project-a", "project-b"]));
    expect(claims.every((claim) => claim.jobImage === IMAGE && claim.serviceId === "pool-main")).toBe(true);
    expect(JSON.stringify(claims)).not.toMatch(/registrar-token|host-a-token|host-b-token|webhookToken/);
  });

  it("never reactivates queued or claimed work after rotation, expiry, and restart", async () => {
    // Given
    let now = 1_000;
    const root = await temporaryRoot();
    const database = join(root, "pool.sqlite3");
    const endpoint = await startService(database, nowClock(() => now));
    const old = await admit(endpoint, admission("project-a", "alpha", 41, "1".repeat(40)));
    await webhook(endpoint, "project-a", token(old), 301, "dim-alpha");
    await webhook(endpoint, "project-a", token(old), 302, "dim-alpha");
    const oldClaim = record(await (await claim(endpoint, "host-a", "old-claim")).json());
    const rotated = await admit(endpoint, admission("project-a", "alpha", 41, "2".repeat(40)));
    expect(token(rotated)).toBe(token(old));
    await closeLatestService();
    now = 1_201;
    const restarted = await startService(database, nowClock(() => now));

    // When
    const staleQueue = await claim(restarted, "host-b", "stale-queue");
    const staleRenewal = await renew(restarted, String(oldClaim.claimId), "host-a");
    const staleRecovery = await recover(restarted, String(oldClaim.claimId), "host-a");
    const freshWebhook = await webhook(restarted, "project-a", token(rotated), 303, "dim-alpha");
    const expiredFreshAdmission = await claim(restarted, "host-b", "expired-fresh");
    await closeLatestService();
    const state = databaseRows(database);

    // Then
    expect([staleQueue.status, staleRenewal.status, staleRecovery.status]).toEqual([204, 409, 204]);
    expect(freshWebhook.status).toBe(404);
    expect(expiredFreshAdmission.status).toBe(204);
    expect(state.queued).toEqual([{ job_id: 302, admission_id: old.admissionId }]);
    expect(state.claims).toEqual([]);
  });

  it("keeps registrar, worker, and webhook credentials on separate surfaces", async () => {
    // Given
    const root = await temporaryRoot();
    const database = join(root, "pool.sqlite3");
    const endpoint = await startService(database);

    // When
    const workerRegisters = await post(endpoint, "/v1/admissions", "host-a-token", admission("project-a", "alpha", 41, "1".repeat(40)));
    const admitted = await admit(endpoint, admission("project-a", "alpha", 41, "1".repeat(40)));
    const registrarClaims = await post(endpoint, "/v1/claims", "registrar-token", {
      hostId: "host-a", capacity: "primary", requestId: "registrar-claim"
    }, { "X-DIM-Host": "host-a" });
    const webhookClaims = await post(endpoint, "/v1/claims", token(admitted), {
      hostId: "host-a", capacity: "primary", requestId: "webhook-claim"
    }, { "X-DIM-Host": "host-a" });

    // Then
    expect([workerRegisters.status, registrarClaims.status, webhookClaims.status]).toEqual([404, 404, 404]);
  });

  it("revokes an exact admission without deleting its queued job", async () => {
    // Given
    const root = await temporaryRoot();
    const database = join(root, "pool.sqlite3");
    const endpoint = await startService(database);
    const admitted = await admit(endpoint, admission("project-a", "alpha", 41, "1".repeat(40)));
    await webhook(endpoint, "project-a", token(admitted), 401, "dim-alpha");

    // When
    const revoked = await post(endpoint, `/v1/admissions/${String(admitted.admissionId)}/revoke`, "registrar-token", {
      projectId: "project-a"
    });
    const dispatched = await claim(endpoint, "host-a", "after-revoke");
    await closeLatestService();
    const state = databaseRows(database);

    // Then
    expect(revoked.status).toBe(204);
    expect(dispatched.status).toBe(204);
    expect(state.queued).toEqual([{ job_id: 401, admission_id: admitted.admissionId }]);
  });
});

function admission(projectId: string, projectName: string, organizationId: number, sourceCommit: string) {
  return {
    projectId, projectName, organization: `dim-${projectName}`, organizationId,
    sourceRef: "refs/heads/main", sourceCommit, configDigest: "c".repeat(64),
    jobImage: IMAGE, runnerLabels: [`dim-${projectName}`]
  };
}

async function startService(
  databaseInput?: string,
  lease = nowClock(Date.now)
): Promise<string> {
  const root = databaseInput === undefined ? await temporaryRoot() : undefined;
  const config = {
    schemaVersion: 2,
    serviceId: "pool-main",
    database: databaseInput ?? join(root ?? "", "pool.sqlite3"),
    jobImage: IMAGE,
    webhookBaseUrl: "http://127.0.0.1:7410",
    registrarToken: "registrar-token",
    admissionLeaseMilliseconds: 100,
    hosts: [
      { hostId: "host-a", token: "host-a-token", capacities: ["primary"] },
      { hostId: "host-b", token: "host-b-token", capacities: ["primary"] }
    ]
  } satisfies OrdinaryCiPoolServiceConfig;
  const service = configuredOrdinaryCiPoolServer(config, lease);
  services.push(service);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  return `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
}

function nowClock(now: () => number) {
  return { now, leaseMilliseconds: 100 };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-trusted-admission-"));
  roots.push(root);
  return root;
}

async function closeLatestService(): Promise<void> {
  const service = services.pop();
  if (service === undefined) throw new Error("pool service is missing");
  service.close();
  await once(service, "close");
}

async function admit(endpoint: string, body: ReturnType<typeof admission>): Promise<Readonly<Record<string, unknown>>> {
  const response = await post(endpoint, "/v1/admissions", "registrar-token", body);
  expect(response.status).toBe(200);
  return record(await response.json());
}

function token(value: Readonly<Record<string, unknown>>): string {
  const result = value.webhookToken;
  if (typeof result !== "string") throw new Error("admission response lacks webhook token");
  return result;
}

function webhook(endpoint: string, projectId: string, authorization: string, jobId: number, label: string): Promise<Response> {
  const projectName = projectId === "project-a" ? "alpha" : "beta";
  const organizationId = projectId === "project-a" ? 41 : 42;
  return post(endpoint, `/v1/webhooks/${projectId}/workflow-job`, authorization, {
    action: "queued", workflow_job: { id: jobId, labels: [label] },
    organization: { id: organizationId, name: `dim-${projectName}` },
    repository: { full_name: `dim-${projectName}/root`, owner: { id: organizationId, login: `dim-${projectName}` } },
    sender: { id: 7, login: "maintainer" }
  }, { "X-Gitea-Event": "workflow_job", "X-Gitea-Hook-Installation-Target-Type": "organization" });
}

function claim(endpoint: string, hostId: string, requestId: string): Promise<Response> {
  return post(endpoint, "/v1/claims", `${hostId}-token`, { hostId, capacity: "primary", requestId }, { "X-DIM-Host": hostId });
}

function renew(endpoint: string, claimId: string, hostId: string): Promise<Response> {
  return post(endpoint, `/v1/claims/${claimId}/renew`, `${hostId}-token`, { hostId }, { "X-DIM-Host": hostId });
}

function recover(endpoint: string, claimId: string, hostId: string): Promise<Response> {
  return post(endpoint, `/v1/claims/${claimId}/recover`, `${hostId}-token`, { hostId, capacity: "primary" }, { "X-DIM-Host": hostId });
}

function post(endpoint: string, path: string, tokenValue: string, body: object, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
  return fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected response object");
  return value as Readonly<Record<string, unknown>>;
}

function databaseRows(file: string): { readonly queued: readonly unknown[]; readonly claims: readonly unknown[] } {
  const database = new DatabaseSync(file, { readOnly: true });
  const rows = {
    queued: database.prepare("SELECT job_id, admission_id FROM queued_jobs ORDER BY job_id").all(),
    claims: database.prepare("SELECT job_id, admission_id FROM claims ORDER BY job_id").all()
  };
  database.close();
  return rows;
}
