import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const schedulerScript = join(
  import.meta.dirname,
  "../../../../core/packages/core/src/shared-qemu-scheduler-assets/server.py"
);

type Project = {
  readonly id: string;
  readonly apiToken: string;
  readonly webhookToken: string;
  readonly hostId: string;
  readonly jobId: number;
};

type Service = {
  readonly endpoint: string;
  process: ChildProcess;
  readonly root: string;
};

type ApiRequest = {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly hostId?: string;
};

type ClaimRequest = {
  readonly target: Project;
  readonly requestId: string;
};

type LeaseRequest = {
  readonly claimId: string;
  readonly operation: "renew" | "release";
};

type WorkflowEventRequest = {
  readonly target: Project;
  readonly action: "queued" | "completed";
};

const projectA = { id: "project-a", apiToken: "api-a", webhookToken: "webhook-a", hostId: "shared-host", jobId: 101 } as const satisfies Project;
const projectB = { id: "project-b", apiToken: "api-b", webhookToken: "webhook-b", hostId: "shared-host", jobId: 101 } as const satisfies Project;
let service: Service | undefined;

afterEach(async () => {
  if (service === undefined) return;
  service.process.kill("SIGTERM");
  if (service.process.exitCode === null) await once(service.process, "exit");
  await rm(service.root, { recursive: true, force: true });
  service = undefined;
});

describe("shared QEMU scheduler Project isolation", () => {
  it("keeps concurrent Project claims isolated across restart", async () => {
    // Given
    service = await startService();
    const ownEvents = await Promise.all([enqueue(service, projectA, projectA), enqueue(service, projectB, projectB)]);
    expect(ownEvents.map(({ status }) => status)).toEqual([202, 202]);

    // When
    const [foreignEnqueueAtoB, foreignEnqueueBtoA, foreignWebhookQueueAtoB, foreignWebhookQueueBtoA] = await Promise.all([
      enqueue(service, projectA, projectB),
      enqueue(service, projectB, projectA),
      workflowEvent(service, projectA, { target: projectB, action: "queued" }),
      workflowEvent(service, projectB, { target: projectA, action: "queued" })
    ]);
    const [foreignClaimAtoB, foreignClaimBtoA] = await Promise.all([
      claim(service, projectA, { target: projectB, requestId: "foreign-a-to-b" }),
      claim(service, projectB, { target: projectA, requestId: "foreign-b-to-a" })
    ]);
    const [claimAResponse, claimBResponse] = await Promise.all([
      claim(service, projectA, { target: projectA, requestId: "claim-a" }),
      claim(service, projectB, { target: projectB, requestId: "claim-b" })
    ]);
    const claimA = await claimBody(claimAResponse);
    const claimB = await claimBody(claimBResponse);
    const [foreignRenewAtoB, foreignReleaseAtoB, foreignCompleteAtoB] = await Promise.all([
      lease(service, projectA, { claimId: claimB.claimId, operation: "renew" }),
      lease(service, projectA, { claimId: claimB.claimId, operation: "release" }),
      workflowEvent(service, projectA, { target: projectB, action: "completed" })
    ]);
    const [foreignRenewBtoA, foreignReleaseBtoA, foreignCompleteBtoA] = await Promise.all([
      lease(service, projectB, { claimId: claimA.claimId, operation: "renew" }),
      lease(service, projectB, { claimId: claimA.claimId, operation: "release" }),
      workflowEvent(service, projectB, { target: projectA, action: "completed" })
    ]);
    await restartService(service);
    const completedA = await workflowEvent(service, projectA, { target: projectA, action: "completed" });
    const [renewedA, renewedB] = await Promise.all([
      lease(service, projectA, { claimId: claimA.claimId, operation: "renew" }),
      lease(service, projectB, { claimId: claimB.claimId, operation: "renew" })
    ]);
    const ownReleases = await Promise.all([
      lease(service, projectA, { claimId: claimA.claimId, operation: "release" }),
      lease(service, projectB, { claimId: claimB.claimId, operation: "release" })
    ]);

    // Then
    expect([
      foreignEnqueueAtoB.status,
      foreignWebhookQueueAtoB.status,
      foreignClaimAtoB.status,
      foreignRenewAtoB.status,
      foreignReleaseAtoB.status,
      foreignCompleteAtoB.status
    ]).toEqual([404, 404, 404, 409, 409, 404]);
    expect([
      foreignEnqueueBtoA.status,
      foreignWebhookQueueBtoA.status,
      foreignClaimBtoA.status,
      foreignRenewBtoA.status,
      foreignReleaseBtoA.status,
      foreignCompleteBtoA.status
    ]).toEqual([404, 404, 404, 409, 409, 404]);
    expect([claimAResponse.status, claimBResponse.status]).toEqual([200, 200]);
    expect([claimA.jobId, claimB.jobId]).toEqual([projectA.jobId, projectB.jobId]);
    expect(claimA.claimId).not.toBe(claimB.claimId);
    expect(completedA.status).toBe(202);
    expect([renewedA.status, renewedB.status]).toEqual([200, 200]);
    expect(ownReleases.map(({ status }) => status)).toEqual([204, 204]);
    expect(await Promise.all([renewedA.json(), renewedB.json()])).toEqual([
      { state: "detached" },
      { state: "renewed", leaseSeconds: 60 }
    ]);
  });
});

async function startService(): Promise<Service> {
  const root = await mkdtemp(join(tmpdir(), "dim-shared-scheduler-projects-"));
  const port = await availablePort();
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    schemaVersion: 1,
    listen: { host: "127.0.0.1", port },
    database: join(root, "scheduler.sqlite3"),
    leaseSeconds: 60,
    projects: {
      [projectA.id]: { webhookToken: projectA.webhookToken, apiToken: projectA.apiToken, labels: ["dim-qemu"] },
      [projectB.id]: { webhookToken: projectB.webhookToken, apiToken: projectB.apiToken, labels: ["dim-qemu"] }
    }
  }), { mode: 0o600 });
  await chmod(config, 0o600);
  const started = {
    endpoint: `http://127.0.0.1:${port}`,
    process: spawn("python3", [schedulerScript, config], { stdio: "ignore" }),
    root
  } satisfies Service;
  await waitForHealth(started);
  return started;
}

async function restartService(running: Service): Promise<void> {
  running.process.kill("SIGTERM");
  await once(running.process, "exit");
  running.process = spawn("python3", [schedulerScript, join(running.root, "config.json")], { stdio: "ignore" });
  await waitForHealth(running);
}

function enqueue(running: Service, authority: Project, target: Project): Promise<Response> {
  return apiRequest(running, authority, {
    path: "/v1/events",
    body: { projectId: target.id, action: "queued", jobId: target.jobId, labels: ["dim-qemu"] }
  });
}

function claim(running: Service, authority: Project, request: ClaimRequest): Promise<Response> {
  return apiRequest(running, authority, {
    path: "/v1/claims",
    body: {
      projectId: request.target.id,
      hostId: request.target.hostId,
      capacity: "capacity",
      labels: ["dim-qemu"],
      requestId: request.requestId
    },
    hostId: request.target.hostId
  });
}

function lease(running: Service, project: Project, request: LeaseRequest): Promise<Response> {
  return apiRequest(running, project, {
    path: `/v1/claims/${request.claimId}/${request.operation}`,
    body: { projectId: project.id, hostId: project.hostId }
  });
}

function workflowEvent(running: Service, authority: Project, request: WorkflowEventRequest): Promise<Response> {
  return fetch(`${running.endpoint}/v1/webhooks/${request.target.id}/workflow-job`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authority.webhookToken}`,
      "Content-Type": "application/json",
      "X-Gitea-Event": "workflow_job"
    },
    body: JSON.stringify({
      action: request.action,
      workflow_job: { id: request.target.jobId, labels: ["dim-qemu"] }
    })
  });
}

function apiRequest(
  running: Service,
  authority: Project,
  request: ApiRequest
): Promise<Response> {
  return fetch(`${running.endpoint}${request.path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authority.apiToken}`,
      "Content-Type": "application/json",
      "X-DIM-Host": request.hostId ?? authority.hostId
    },
    body: JSON.stringify(request.body)
  });
}

async function claimBody(response: Response): Promise<{ readonly claimId: string; readonly jobId: number }> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("claimId" in body) || typeof body.claimId !== "string"
    || !("jobId" in body) || typeof body.jobId !== "number") {
    throw new Error("scheduler claim response omitted claim identity");
  }
  return { claimId: body.claimId, jobId: body.jobId };
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

async function waitForHealth(running: Service): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${running.endpoint}/healthz`)).status === 200) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for scheduler service");
}
