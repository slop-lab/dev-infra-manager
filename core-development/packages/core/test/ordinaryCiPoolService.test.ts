import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredOrdinaryCiPoolServer,
  type OrdinaryCiPoolServiceConfig
} from "../../../../core/packages/core/src/ordinaryCiPoolService.js";

const IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;
const services: ReturnType<typeof configuredOrdinaryCiPoolServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    service.close();
    await once(service, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI pool control plane", () => {
  it("admits an enrolled Gitea organization workflow job with real extra fields", async () => {
    // Given
    const endpoint = await startService();

    // When
    const accepted = await webhook(endpoint, "project-a", "webhook-a", 100);
    const dispatched = await claim(endpoint, "host-a", "host-a-token", "primary", "real-gitea-payload");

    // Then
    expect(accepted.status).toBe(202);
    expect(dispatched.status).toBe(200);
  });

  it("rejects a valid project token carrying another organization identity without recording demand", async () => {
    // Given
    const endpoint = await startService();
    const payload = workflowJobPayload(150, "queued", { id: 42, name: "dim-beta" });

    // When
    const rejected = await fetch(`${endpoint}/v1/webhooks/project-a/workflow-job`, {
      method: "POST",
      headers: {
        Authorization: "Bearer webhook-a", "Content-Type": "application/json",
        "X-Gitea-Event": "workflow_job", "X-Gitea-Hook-Installation-Target-Type": "organization"
      },
      body: JSON.stringify(payload)
    });
    const dispatched = await claim(endpoint, "host-a", "host-a-token", "primary", "wrong-organization");

    // Then
    expect(rejected.status).toBe(404);
    expect(dispatched.status).toBe(204);
  });

  it("rejects malformed organization attribution without recording demand", async () => {
    // Given
    const endpoint = await startService();
    const payload = { ...workflowJobPayload(175, "queued", { id: 41, name: "dim-alpha" }), repository: null };

    // When
    const rejected = await fetch(`${endpoint}/v1/webhooks/project-a/workflow-job`, {
      method: "POST",
      headers: {
        Authorization: "Bearer webhook-a", "Content-Type": "application/json",
        "X-Gitea-Event": "workflow_job", "X-Gitea-Hook-Installation-Target-Type": "organization"
      },
      body: JSON.stringify(payload)
    });
    const dispatched = await claim(endpoint, "host-a", "host-a-token", "primary", "malformed-organization");

    // Then
    expect(rejected.status).toBe(400);
    expect(dispatched.status).toBe(204);
  });

  it("globally fences host capacities while dispatching two enrolled organizations", async () => {
    // Given
    const endpoint = await startService();
    await webhook(endpoint, "project-a", "webhook-a", 101);
    await webhook(endpoint, "project-b", "webhook-b", 202);

    // When
    const [hostA, hostB] = await Promise.all([
      claim(endpoint, "host-a", "host-a-token", "primary", "request-a"),
      claim(endpoint, "host-b", "host-b-token", "primary", "request-b")
    ]);
    const duplicateCapacity = await claim(endpoint, "host-a", "host-a-token", "primary", "request-c");

    // Then
    expect([hostA.status, hostB.status, duplicateCapacity.status]).toEqual([200, 200, 204]);
    const claims = await Promise.all([hostA.json(), hostB.json()]) as Array<{
      readonly projectId: string;
      readonly organization: string;
      readonly jobImage: string;
    }>;
    expect(new Set(claims.map((item) => item.projectId))).toEqual(new Set(["project-a", "project-b"]));
    expect(new Set(claims.map((item) => item.organization))).toEqual(new Set(["dim-alpha", "dim-beta"]));
    expect(claims.every((item) => item.jobImage === IMAGE)).toBe(true);
  });

  it("rejects webhook demand from a non-enrolled organization", async () => {
    // Given
    const endpoint = await startService();

    // When
    const response = await webhook(endpoint, "outside", "outside-token", 303);

    // Then
    expect(response.status).toBe(404);
  });

  it("does not requeue a completed job after delayed duplicate delivery", async () => {
    // Given
    const endpoint = await startService();
    await webhook(endpoint, "project-a", "webhook-a", 303, "completed");

    // When
    await webhook(endpoint, "project-a", "webhook-a", 303);
    const response = await claim(endpoint, "host-a", "host-a-token", "primary", "delayed-duplicate");

    // Then
    expect(response.status).toBe(204);
  });

  it("retains host-capacity fences across a control-plane restart", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-pool-service-"));
    roots.push(root);
    const database = join(root, "pool.sqlite3");
    const first = await startService(database);
    await webhook(first, "project-a", "webhook-a", 404);
    expect((await claim(first, "host-a", "host-a-token", "primary", "before-restart")).status).toBe(200);
    await closeLatestService();

    // When
    const restarted = await startService(database);
    await webhook(restarted, "project-b", "webhook-b", 405);
    const duplicate = await claim(restarted, "host-a", "host-a-token", "primary", "after-restart");

    // Then
    expect(duplicate.status).toBe(204);
  });

  it("requires cleanup acknowledgement before recovering an expired lease after restart", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-pool-lease-"));
    roots.push(root);
    const database = join(root, "pool.sqlite3");
    let now = 1_000;
    const first = await startService(database, { now: () => now, leaseMilliseconds: 100 });
    await webhook(first, "project-a", "webhook-a", 505);
    const original = await claim(first, "host-a", "host-a-token", "primary", "original");
    const originalBody = await original.json() as { readonly claimId: string };
    await closeLatestService();
    now = 1_101;
    const restarted = await startService(database, { now: () => now, leaseMilliseconds: 100 });

    // When
    const beforeCleanup = await claim(restarted, "host-a", "host-a-token", "primary", "replacement");
    const recovery = await beforeCleanup.json() as { readonly expiredClaim: { readonly claimId: string } };
    const stillFenced = await claim(restarted, "host-a", "host-a-token", "primary", "replacement-2");
    const recovered = await recover(restarted, "host-a", "host-a-token", "primary", originalBody.claimId);
    const replacement = await claim(restarted, "host-a", "host-a-token", "primary", "replacement-3");

    // Then
    expect(beforeCleanup.status).toBe(409);
    expect(recovery.expiredClaim.claimId).toBe(originalBody.claimId);
    expect(stillFenced.status).toBe(409);
    expect(recovered.status).toBe(204);
    expect(replacement.status).toBe(200);
  });

  it("makes expired recovery replay-idempotent without weakening active or ownership fences", async () => {
    // Given
    let now = 1_000;
    const endpoint = await startService(undefined, { now: () => now, leaseMilliseconds: 100 });
    await webhook(endpoint, "project-a", "webhook-a", 515);
    const original = await claim(endpoint, "host-a", "host-a-token", "primary", "recovery-matrix");
    const body = await original.json() as { readonly claimId: string };

    // When
    const active = await recover(endpoint, "host-a", "host-a-token", "primary", body.claimId);
    now = 1_101;
    const wrongHost = await recover(endpoint, "host-b", "host-b-token", "primary", body.claimId);
    const wrongCapacity = await recover(endpoint, "host-a", "host-a-token", "secondary", body.claimId);
    const unauthorized = await recover(endpoint, "host-a", "wrong-token", "primary", body.claimId);
    const first = await recover(endpoint, "host-a", "host-a-token", "primary", body.claimId);
    const duplicate = await recover(endpoint, "host-a", "host-a-token", "primary", body.claimId);

    // Then
    expect([active.status, wrongHost.status, wrongCapacity.status, unauthorized.status]).toEqual([409, 409, 409, 404]);
    expect([first.status, duplicate.status]).toEqual([204, 204]);
  });

  it("extends an active lease through the authenticated renew endpoint", async () => {
    // Given
    let now = 2_000;
    const endpoint = await startService(undefined, { now: () => now, leaseMilliseconds: 100 });
    await webhook(endpoint, "project-a", "webhook-a", 606);
    const original = await claim(endpoint, "host-a", "host-a-token", "primary", "renewed");
    const body = await original.json() as { readonly claimId: string };
    now = 2_050;

    // When
    const renewed = await renew(endpoint, "host-a", "host-a-token", body.claimId);
    now = 2_101;
    const competing = await claim(endpoint, "host-a", "host-a-token", "primary", "competitor");

    // Then
    expect(renewed.status).toBe(200);
    expect(competing.status).toBe(204);
  });

  it("stops renewing a claimed job that completes before the runner consumes it", async () => {
    // Given
    const endpoint = await startService();
    await webhook(endpoint, "project-a", "webhook-a", 707);
    const claimed = await claim(endpoint, "host-a", "host-a-token", "primary", "cancel-before-run");
    const body = await claimed.json() as { readonly claimId: string };

    // When
    await webhook(endpoint, "project-a", "webhook-a", 707, "completed");
    const renewed = await renew(endpoint, "host-a", "host-a-token", body.claimId);

    // Then
    expect(renewed.status).toBe(409);
  });

  it("continues renewing a claimed job after an in-progress event", async () => {
    // Given
    const endpoint = await startService();
    await webhook(endpoint, "project-a", "webhook-a", 808);
    const claimed = await claim(endpoint, "host-a", "host-a-token", "primary", "job-started");
    const body = await claimed.json() as { readonly claimId: string };

    // When
    await webhook(endpoint, "project-a", "webhook-a", 808, "in_progress");
    const renewed = await renew(endpoint, "host-a", "host-a-token", body.claimId);

    // Then
    expect(renewed.status).toBe(200);
  });
});

async function startService(
  databaseInput?: string,
  lease?: { readonly now: () => number; readonly leaseMilliseconds: number }
): Promise<string> {
  const root = databaseInput === undefined ? await mkdtemp(join(tmpdir(), "dim-ordinary-pool-service-")) : undefined;
  if (root !== undefined) roots.push(root);
  const config: OrdinaryCiPoolServiceConfig = {
    schemaVersion: 1,
    database: databaseInput ?? join(root ?? "", "pool.sqlite3"),
    jobImage: IMAGE,
    runnerLabel: "dim-ordinary",
    projects: [
      { projectId: "project-a", projectName: "alpha", organization: "dim-alpha", organizationId: 41, webhookToken: "webhook-a" },
      { projectId: "project-b", projectName: "beta", organization: "dim-beta", organizationId: 42, webhookToken: "webhook-b" }
    ],
    hosts: [
      { hostId: "host-a", token: "host-a-token", capacities: ["primary", "secondary"] },
      { hostId: "host-b", token: "host-b-token", capacities: ["primary"] }
    ]
  };
  const service = configuredOrdinaryCiPoolServer(config, lease);
  services.push(service);
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const address = service.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function renew(endpoint: string, hostId: string, token: string, claimId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims/${claimId}/renew`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-DIM-Host": hostId },
    body: JSON.stringify({ hostId })
  });
}

function recover(
  endpoint: string,
  hostId: string,
  token: string,
  capacity: string,
  claimId: string
): Promise<Response> {
  return fetch(`${endpoint}/v1/claims/${claimId}/recover`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-DIM-Host": hostId },
    body: JSON.stringify({ hostId, capacity })
  });
}

async function closeLatestService(): Promise<void> {
  const service = services.pop();
  if (service === undefined) throw new Error("ordinary pool service is missing");
  service.close();
  await once(service, "close");
}

function webhook(
  endpoint: string,
  projectId: string,
  token: string,
  jobId: number,
  action: "queued" | "in_progress" | "completed" = "queued"
): Promise<Response> {
  const organization = projectId === "project-b"
    ? { id: 42, name: "dim-beta" }
    : { id: 41, name: "dim-alpha" };
  return fetch(`${endpoint}/v1/webhooks/${projectId}/workflow-job`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Gitea-Event": "workflow_job",
      "X-Gitea-Hook-Installation-Target-Type": "organization"
    },
    body: JSON.stringify(workflowJobPayload(jobId, action, organization))
  });
}

function workflowJobPayload(
  jobId: number,
  action: "queued" | "in_progress" | "completed",
  organization: { readonly id: number; readonly name: string }
): Readonly<Record<string, unknown>> {
  return {
    action,
    workflow_job: {
      id: jobId, run_id: 700, name: "verify", labels: ["dim-ordinary"], run_attempt: 1,
      head_sha: "a".repeat(40), status: action, runner_id: 0, steps: null
    },
    organization: { ...organization, full_name: "DIM Project organization", username: organization.name },
    repository: {
      id: 900, name: "root", full_name: `${organization.name}/root`,
      owner: { id: organization.id, login: organization.name, username: organization.name, is_admin: false },
      private: true, default_branch: "main"
    },
    sender: { id: 7, login: "dim-maintainer", username: "dim-maintainer", is_admin: false }
  };
}

function claim(endpoint: string, hostId: string, token: string, capacity: string, requestId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-DIM-Host": hostId },
    body: JSON.stringify({ hostId, capacity, requestId })
  });
}
