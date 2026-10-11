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

describe("ordinary CI admission generations", () => {
  it("allocates a fresh generation after revoke and restart without reactivating queued work", async () => {
    // Given
    const fixture = await serviceFixture();
    const first = await admit(fixture.endpoint);
    await webhook(fixture.endpoint, token(first), 901);
    const revoked = await post(fixture.endpoint, {
      path: `/v1/admissions/${admissionId(first)}/revoke`,
      authorization: "registrar-token",
      body: { projectId: "project-a" }
    });
    const fencedBeforeRestart = await claim(fixture.endpoint, "before-restart");
    await fixture.restart();

    // When
    const replacement = await admit(fixture.endpoint);
    const stale = await claim(fixture.endpoint, "stale-after-revoke");
    const state = rows(fixture.database);

    // Then
    expect([revoked.status, fencedBeforeRestart.status, stale.status]).toEqual([204, 204, 204]);
    expect(admissionId(replacement)).not.toBe(admissionId(first));
    expect(state.queued).toEqual([{ job_id: 901, admission_id: admissionId(first) }]);
  });

  it("allocates a fresh generation after expiry and restart without reactivating queued work", async () => {
    // Given
    const fixture = await serviceFixture();
    const first = await admit(fixture.endpoint);
    await webhook(fixture.endpoint, token(first), 902);
    fixture.advancePastAdmission();
    await fixture.restart();

    // When
    const replacement = await admit(fixture.endpoint);
    const stale = await claim(fixture.endpoint, "stale-after-expiry");
    const state = rows(fixture.database);

    // Then
    expect(stale.status).toBe(204);
    expect(admissionId(replacement)).not.toBe(admissionId(first));
    expect(state.queued).toEqual([{ job_id: 902, admission_id: admissionId(first) }]);
  });

  it("does not requeue an expired old-generation claim after replacement admission", async () => {
    // Given
    const fixture = await serviceFixture();
    const first = await admit(fixture.endpoint);
    await webhook(fixture.endpoint, token(first), 903);
    const oldClaim = record(await (await claim(fixture.endpoint, "old-expiring-claim")).json());
    fixture.advancePastAdmission();
    await fixture.restart();
    const replacement = await admit(fixture.endpoint);

    // When
    const recovered = await recover(fixture.endpoint, String(oldClaim.claimId));
    const stale = await claim(fixture.endpoint, "after-old-recovery");
    const state = rows(fixture.database);

    // Then
    expect([recovered.status, stale.status]).toEqual([204, 204]);
    expect(admissionId(replacement)).not.toBe(admissionId(first));
    expect(state).toEqual({ queued: [], claims: [] });
  });

  it("retains the generation and webhook token for an active identical-policy refresh", async () => {
    // Given
    const fixture = await serviceFixture();
    const first = await admit(fixture.endpoint);

    // When
    const refreshed = await admit(fixture.endpoint);

    // Then
    expect(admissionId(refreshed)).toBe(admissionId(first));
    expect(token(refreshed)).toBe(token(first));
  });

  it("allocates a fresh generation while retaining the webhook token when active policy changes", async () => {
    // Given
    const fixture = await serviceFixture();
    const first = await admit(fixture.endpoint);

    // When
    const rotated = await admit(fixture.endpoint, policy("2".repeat(40)));

    // Then
    expect(admissionId(rotated)).not.toBe(admissionId(first));
    expect(token(rotated)).toBe(token(first));
  });
});

async function serviceFixture(): Promise<{
  readonly database: string;
  endpoint: string;
  readonly advancePastAdmission: () => void;
  readonly restart: () => Promise<void>;
}> {
  let now = 1_000;
  const root = await mkdtemp(join(tmpdir(), "dim-admission-generation-"));
  roots.push(root);
  const database = join(root, "pool.sqlite3");
  const fixture = {
    database,
    endpoint: await startService(database, () => now),
    advancePastAdmission: () => { now = 1_201; },
    restart: async () => {
      await closeLatestService();
      fixture.endpoint = await startService(database, () => now);
    }
  };
  return fixture;
}

async function startService(database: string, now: () => number): Promise<string> {
  const config = {
    schemaVersion: 2,
    serviceId: "pool-main",
    database,
    jobImage: IMAGE,
    webhookBaseUrl: "http://127.0.0.1:7410",
    registrarToken: "registrar-token",
    admissionLeaseMilliseconds: 100,
    hosts: [{ hostId: "host-a", token: "host-a-token", capacities: ["primary"] }]
  } satisfies OrdinaryCiPoolServiceConfig;
  const service = configuredOrdinaryCiPoolServer(config, { now, leaseMilliseconds: 100 });
  services.push(service);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  return `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
}

async function closeLatestService(): Promise<void> {
  const service = services.pop();
  if (service === undefined) throw new Error("pool service is missing");
  service.close();
  await once(service, "close");
}

function policy(sourceCommit = "1".repeat(40)) {
  return {
    projectId: "project-a", projectName: "alpha", organization: "dim-alpha", organizationId: 41,
    sourceRef: "refs/heads/main", sourceCommit, configDigest: "c".repeat(64),
    jobImage: IMAGE, runnerLabels: ["dim-alpha"]
  };
}

async function admit(endpoint: string, body = policy()): Promise<Readonly<Record<string, unknown>>> {
  const response = await post(endpoint, { path: "/v1/admissions", authorization: "registrar-token", body });
  expect(response.status).toBe(200);
  return record(await response.json());
}

function webhook(endpoint: string, authorization: string, jobId: number): Promise<Response> {
  return post(endpoint, {
    path: "/v1/webhooks/project-a/workflow-job",
    authorization,
    body: {
      action: "queued", workflow_job: { id: jobId, labels: ["dim-alpha"] },
      organization: { id: 41, name: "dim-alpha" },
      repository: { full_name: "dim-alpha/root", owner: { id: 41, login: "dim-alpha" } },
      sender: { id: 7, login: "maintainer" }
    },
    headers: { "X-Gitea-Event": "workflow_job", "X-Gitea-Hook-Installation-Target-Type": "organization" }
  });
}

function claim(endpoint: string, requestId: string): Promise<Response> {
  return post(endpoint, {
    path: "/v1/claims", authorization: "host-a-token",
    body: { hostId: "host-a", capacity: "primary", requestId }, headers: { "X-DIM-Host": "host-a" }
  });
}

function recover(endpoint: string, claimId: string): Promise<Response> {
  return post(endpoint, {
    path: `/v1/claims/${claimId}/recover`, authorization: "host-a-token",
    body: { hostId: "host-a", capacity: "primary" }, headers: { "X-DIM-Host": "host-a" }
  });
}

type PostRequest = {
  readonly path: string;
  readonly authorization: string;
  readonly body: object;
  readonly headers?: Readonly<Record<string, string>>;
};

function post(endpoint: string, request: PostRequest): Promise<Response> {
  return fetch(`${endpoint}${request.path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${request.authorization}`, "Content-Type": "application/json", ...request.headers },
    body: JSON.stringify(request.body)
  });
}

function admissionId(value: Readonly<Record<string, unknown>>): string {
  if (typeof value.admissionId !== "string") throw new Error("admission response lacks an admission ID");
  return value.admissionId;
}

function token(value: Readonly<Record<string, unknown>>): string {
  if (typeof value.webhookToken !== "string") throw new Error("admission response lacks a webhook token");
  return value.webhookToken;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected response object");
  return value as Readonly<Record<string, unknown>>;
}

function rows(file: string): { readonly queued: readonly unknown[]; readonly claims: readonly unknown[] } {
  const database = new DatabaseSync(file, { readOnly: true });
  const state = {
    queued: database.prepare("SELECT job_id, admission_id FROM queued_jobs ORDER BY job_id").all(),
    claims: database.prepare("SELECT job_id, admission_id FROM claims ORDER BY job_id").all()
  };
  database.close();
  return state;
}
