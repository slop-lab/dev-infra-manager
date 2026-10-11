import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const schedulerScript = join(
  import.meta.dirname,
  "../../../../core/packages/core/src/shared-qemu-scheduler-assets/server.py"
);

type Service = {
  readonly endpoint: string;
  readonly process: ChildProcess;
  readonly root: string;
};

const services: Service[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => {
    service.process.kill("SIGTERM");
    if (service.process.exitCode === null) await once(service.process, "exit");
    await rm(service.root, { recursive: true, force: true });
  }));
});

describe("shared QEMU scheduler HTTP protocol", () => {
  it("admits exactly one host claim", async () => {
    // Given
    const service = await startService();
    await event(service, "queued", 101, ["dim-qemu"]);

    // When
    const [first, second] = await Promise.all([
      claim(service, "host-a", "service-secret", "capacity", "request-a"),
      claim(service, "host-b", "service-secret", "capacity", "request-b")
    ]);

    // Then
    const winners = [first, second].filter((response) => response.status === 200);
    expect(winners).toHaveLength(1);
    expect([first.status, second.status].sort()).toEqual([200, 204]);
    const winner = winners[0];
    expect(winner).toBeDefined();
    expect(await winner?.json()).toMatchObject({ leaseSeconds: 60 });
  });

  it("makes retries idempotent, persists restart state, and keeps terminal events monotonic", async () => {
    // Given
    const service = await startService();
    await event(service, "queued", 201, ["dim-qemu"]);
    const first = await claim(service, "host-a", "service-secret", "capacity", "stable-request");
    const firstBody = await first.json() as { readonly claimId: string };

    // When
    const retried = await claim(service, "host-a", "service-secret", "capacity", "stable-request");
    const retriedBody = await retried.json() as { readonly claimId: string };
    await event(service, "completed", 201, ["dim-qemu"]);
    await event(service, "queued", 201, ["dim-qemu"]);
    await restartService(service);

    // Then
    expect(retriedBody).toEqual(firstBody);
    const renewal = await renew(service, "host-a", "service-secret", firstBody.claimId);
    expect(renewal.status).toBe(200);
    expect(await renewal.json()).toEqual({ state: "detached" });
    expect((await claim(service, "host-a", "service-secret", "capacity", "stable-request")).status).toBe(204);
    expect((await claim(service, "host-b", "service-secret", "capacity", "new-request")).status).toBe(204);
  });

  it("returns the exact claim, renewal, and release status contract", async () => {
    // Given
    const service = await startService();
    await event(service, "queued", 211, ["dim-qemu"]);

    // When
    const claimed = await claim(service, "host-a", "service-secret", "capacity", "status-contract");
    const body = await claimed.json() as { readonly claimId: string };
    const idle = await claim(service, "host-b", "service-secret", "capacity", "idle");
    const renewed = await renew(service, "host-a", "service-secret", body.claimId);
    const lostRenewal = await renew(service, "host-b", "service-secret", body.claimId);
    const released = await release(service, "host-a", "service-secret", body.claimId);
    const lostRelease = await release(service, "host-a", "service-secret", body.claimId);

    // Then
    expect(body.claimId).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect([claimed.status, idle.status, renewed.status, lostRenewal.status, released.status, lostRelease.status])
      .toEqual([200, 204, 200, 409, 204, 409]);
  });

  it("authorizes the bound project and host and rejects executable scheduling fields", async () => {
    // Given
    const service = await startService();

    // When
    const wrongHost = await request(service, "/v1/claims", "host-b", "service-secret", {
      projectId: "shared-project", hostId: "host-a", capacity: "capacity",
      labels: ["dim-qemu"], requestId: "wrong-host"
    });
    const executable = await request(service, "/v1/claims", "host-a", "service-secret", {
      projectId: "shared-project", hostId: "host-a", capacity: "capacity",
      labels: ["dim-qemu"], requestId: "payload", command: ["sh"]
    });
    const wrongProject = await request(service, "/v1/claims", "host-a", "service-secret", {
      projectId: "other-project", hostId: "host-a", capacity: "capacity",
      labels: ["dim-qemu"], requestId: "wrong-project"
    });
    const oversized = await fetch(`${service.endpoint}/v1/claims`, {
      method: "POST",
      headers: {
        Authorization: "Bearer service-secret",
        "Content-Type": "application/json",
        "X-DIM-Host": "host-a"
      },
      body: `{"padding":"${"x".repeat(65_537)}"}`
    });

    // Then
    expect(wrongHost.status).toBe(404);
    expect(wrongProject.status).toBe(404);
    expect(executable.status).toBe(400);
    expect(oversized.status).toBe(400);
  });

  it.each([
    ["duplicate keys", '{"projectId":"shared-project","projectId":"shared-project","hostId":"host-a","capacity":"capacity","labels":["dim-qemu"],"requestId":"duplicate"}'],
    ["non-finite numbers", '{"projectId":"shared-project","hostId":"host-a","capacity":"capacity","labels":["dim-qemu"],"requestId":"nonfinite","extra":NaN}']
  ])("rejects %s at the JSON boundary", async (_name, body) => {
    // Given
    const service = await startService();

    // When
    const response = await fetch(`${service.endpoint}/v1/claims`, {
      method: "POST",
      headers: {
        Authorization: "Bearer service-secret",
        "Content-Type": "application/json",
        "X-DIM-Host": "host-a"
      },
      body
    });

    // Then
    expect(response.status).toBe(400);
  });

  it("limits API backlog authority to queued events and ignores unrelated labels", async () => {
    const service = await startService();
    const completed = await request(service, "/v1/events", "host-a", "service-secret", {
      projectId: "shared-project", action: "completed", jobId: 401, labels: ["dim-qemu"]
    });
    const arbitraryLabels = await request(service, "/v1/events", "host-a", "service-secret", {
      projectId: "shared-project", action: "queued", jobId: 402, labels: ["host-command"]
    });

    expect(completed.status).toBe(400);
    expect(arbitraryLabels.status).toBe(202);
    expect((await claim(service, "host-a", "service-secret", "capacity", "unrelated-api-demand")).status).toBe(204);
  });

  it("filters demand by labels and accepts duplicate out-of-order events idempotently", async () => {
    // Given
    const service = await startService();
    await event(service, "in_progress", 301, ["dim-qemu"]);
    await event(service, "queued", 301, ["dim-qemu"]);
    await event(service, "queued", 302, ["ordinary"]);
    await event(service, "queued", 303, ["dim-qemu"]);
    await event(service, "queued", 303, ["dim-qemu"]);

    // When
    const response = await claim(service, "host-a", "service-secret", "capacity", "labels");

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jobId: 303 });
  });

  it("acknowledges unrelated and empty-label webhook demand without recording it", async () => {
    // Given
    const service = await startService();

    // When
    const ordinary = await webhook(service, "queued", 311, ["ordinary"], "webhook-secret");
    const empty = await webhook(service, "queued", 312, [], "webhook-secret");
    const claimResponse = await claim(service, "host-a", "service-secret", "capacity", "ignored-demand");

    // Then
    expect([ordinary.status, empty.status, claimResponse.status]).toEqual([202, 202, 204]);
  });

  it("requires webhook authority for terminal events", async () => {
    // Given
    const service = await startService();
    await event(service, "queued", 321, ["dim-qemu"]);

    // When
    const projectToken = await webhook(service, "completed", 321, ["dim-qemu"], "service-secret");
    const webhookToken = await webhook(service, "completed", 321, ["dim-qemu"], "webhook-secret");

    // Then
    expect([projectToken.status, webhookToken.status]).toEqual([404, 202]);
  });
});

async function startService(options: { readonly leaseSeconds?: number } = {}): Promise<Service> {
  const root = await mkdtemp(join(tmpdir(), "dim-shared-scheduler-"));
  const port = await availablePort();
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    schemaVersion: 1,
    listen: { host: "127.0.0.1", port },
    database: join(root, "scheduler.sqlite3"),
    leaseSeconds: options.leaseSeconds ?? 60,
    projects: {
      "shared-project": {
        webhookToken: "webhook-secret",
        apiToken: "service-secret",
        labels: ["dim-qemu"]
      }
    }
  }), { mode: 0o600 });
  await chmod(config, 0o600);
  const process = spawn("python3", [schedulerScript, config], { stdio: "ignore" });
  const service = { endpoint: `http://127.0.0.1:${port}`, process, root };
  services.push(service);
  await waitFor(async () => (await fetch(`${service.endpoint}/healthz`)).status === 200);
  return service;
}

async function restartService(service: Service): Promise<void> {
  service.process.kill("SIGTERM");
  await once(service.process, "exit");
  const config = join(service.root, "config.json");
  const replacement = spawn("python3", [schedulerScript, config], { stdio: "ignore" });
  Object.assign(service, { process: replacement });
  await waitFor(async () => (await fetch(`${service.endpoint}/healthz`)).status === 200);
}

async function event(service: Service, action: string, jobId: number, labels: readonly string[]): Promise<void> {
  const response = await webhook(service, action, jobId, labels, "webhook-secret");
  expect(response.status).toBe(202);
}

function webhook(service: Service, action: string, jobId: number, labels: readonly string[], token: string): Promise<Response> {
  return fetch(`${service.endpoint}/v1/webhooks/shared-project/workflow-job`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Gitea-Event": "workflow_job" },
    body: JSON.stringify({ action, workflow_job: { id: jobId, labels } })
  });
}

function claim(service: Service, hostId: string, token: string, capacity: string, requestId: string): Promise<Response> {
  return request(service, "/v1/claims", hostId, token, {
    projectId: "shared-project", hostId, capacity, labels: ["dim-qemu"], requestId
  });
}

function renew(service: Service, hostId: string, token: string, claimId: string): Promise<Response> {
  return request(service, `/v1/claims/${claimId}/renew`, hostId, token, { projectId: "shared-project", hostId });
}

function release(service: Service, hostId: string, token: string, claimId: string): Promise<Response> {
  return request(service, `/v1/claims/${claimId}/release`, hostId, token, { projectId: "shared-project", hostId });
}

function request(service: Service, path: string, hostId: string, token: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
  return fetch(`${service.endpoint}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-DIM-Host": hostId },
    body: JSON.stringify(body)
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (await condition()) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for scheduler service");
}
