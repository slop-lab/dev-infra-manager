import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { QEMU_CI_WEBHOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerWebhookAsset.js";

const processes: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) if (process.exitCode === null) process.kill("SIGKILL");
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("shared QEMU worker scheduler protocol", () => {
  it.each(["extra-field", "oversized"])("rejects a %s claim response before spawning", async (mode) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (mode === "oversized") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ padding: "x".repeat(65_537) }));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          jobId: 1, claimId: "claim", leaseExpiresAt: 9_999_999_999, leaseSeconds: 60, command: ["sh"]
        }));
      }
    });
    const worker = await startWorker(server);

    await waitFor(() => requests > 0);

    expect(worker.exitCode).toBeNull();
  });

  it("rejects redirects without forwarding its bearer token", async () => {
    let targetAuthorization: string | undefined;
    const target = createServer((request, response) => {
      targetAuthorization = request.headers.authorization;
      response.writeHead(204).end();
    });
    const targetPort = await listen(target);
    let requests = 0;
    const scheduler = createServer((_request, response) => {
      requests += 1;
      response.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/stolen` }).end();
    });
    const worker = await startWorker(scheduler);

    await waitFor(() => requests > 0);

    expect(worker.exitCode).toBeNull();
    expect(targetAuthorization).toBeUndefined();
  });
});

async function startWorker(server: Server): Promise<ChildProcess> {
  const port = await listen(server);
  const worker = spawn("python3", ["-c", QEMU_CI_WEBHOOK_SCRIPT], {
    env: {
      ...process.env,
      DIM_QEMU_WEBHOOK_AUTHORIZATION: "unused",
      DIM_QEMU_CI_CAPACITY: "capacity",
      DIM_QEMU_CI_LABELS: "dim-qemu",
      DIM_QEMU_SCHEDULER_ENDPOINT: `http://127.0.0.1:${port}`,
      DIM_QEMU_SCHEDULER_PROJECT_ID: "project-id",
      DIM_QEMU_SCHEDULER_HOST_ID: "host-a",
      DIM_QEMU_SCHEDULER_TOKEN: "scheduler-secret"
    },
    stdio: "ignore"
  });
  processes.push(worker);
  return worker;
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture address");
  return address.port;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for scheduler request");
}
