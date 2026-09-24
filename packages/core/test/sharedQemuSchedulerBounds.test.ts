import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const schedulerScript = join(
  import.meta.dirname,
  "../../../../core/packages/core/src/shared-qemu-scheduler-assets/server.py"
);
const clients: Socket[] = [];
let service: { readonly endpoint: string; readonly process: ChildProcess; readonly root: string } | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  if (service !== undefined) {
    service.process.kill("SIGTERM");
    if (service.process.exitCode === null) await once(service.process, "exit");
    await rm(service.root, { recursive: true, force: true });
    service = undefined;
  }
});

describe("shared QEMU scheduler request bounds", () => {
  it("releases handler slots when request thread startup fails", async () => {
    // Given / When
    service = await startService(32);

    // Then
    const response = await fetch(`${service.endpoint}/healthz`);
    expect(response.status).toBe(200);
  });

  it("expires mixed slow headers and bodies by total deadline and releases every handler slot", async () => {
    // Given
    service = await startService();
    const port = Number(new URL(service.endpoint).port);
    const states: Array<{ readonly client: Socket; response: string; readonly closed: Promise<unknown[]> }> = [];
    for (let index = 0; index < 32; index += 1) {
      const client = createConnection({ host: "127.0.0.1", port });
      clients.push(client);
      client.on("error", () => undefined);
      await once(client, "connect");
      client.write(index % 2 === 0
        ? "POST /v1/events HTTP/1.1\r\nHost: localhost\r\nX-Slow: "
        : "POST /v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer api-secret\r\nX-DIM-Host: host-a\r\nContent-Type: application/json\r\nContent-Length: 65536\r\n\r\n{");
      const state = { client, response: "", closed: once(client, "close") };
      client.on("data", (chunk: Buffer) => { state.response += chunk.toString("utf8"); });
      states.push(state);
    }
    const processId = service.process.pid;
    if (processId === undefined) throw new Error("scheduler process has no PID");
    await waitFor(async () => (await readdir(`/proc/${processId}/task`)).length >= 65, 2_000);
    const drip = setInterval(() => {
      for (const state of states) if (state.response === "" && state.client.writable) state.client.write("x");
    }, 250);

    // When
    const saturatedStarted = performance.now();
    const boundedRejection = await rawRequest(port, "GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    const saturatedElapsed = performance.now() - saturatedStarted;
    await within(Promise.all(states.map((state) => state.closed)), 11_000, "slow clients exceeded total deadline");
    clearInterval(drip);
    const recovered = await fetch(`${service.endpoint}/healthz`);

    // Then
    expect(boundedRejection).toContain(" 503 ");
    expect(saturatedElapsed).toBeLessThan(1_000);
    expect(recovered.status).toBe(200);
  }, 15_000);
});

async function startService(failedThreadStarts = 0): Promise<{ readonly endpoint: string; readonly process: ChildProcess; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-shared-scheduler-bounds-"));
  const port = await availablePort();
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({
    schemaVersion: 1,
    listen: { host: "127.0.0.1", port },
    database: join(root, "scheduler.sqlite3"),
    leaseSeconds: 60,
    projects: { project: { webhookToken: "webhook-secret", apiToken: "api-secret", labels: ["dim-qemu"] } }
  }), { mode: 0o600 });
  await chmod(config, 0o600);
  await writeFile(join(root, "sitecustomize.py"), `
import os
import threading

original_start = threading.Thread.start
remaining_failures = int(os.environ["DIM_FAIL_THREAD_STARTS"])

def fail_request_thread_start(thread):
    global remaining_failures
    target = getattr(thread, "_target", None)
    if remaining_failures > 0 and getattr(target, "__name__", "") == "process_request_thread":
        remaining_failures -= 1
        raise RuntimeError("injected request thread startup failure")
    return original_start(thread)

threading.Thread.start = fail_request_thread_start
`);
  const childProcess = spawn("python3", [schedulerScript, config], {
    env: { ...process.env, DIM_FAIL_THREAD_STARTS: String(failedThreadStarts), PYTHONPATH: root },
    stdio: "ignore"
  });
  const started = { endpoint: `http://127.0.0.1:${port}`, process: childProcess, root };
  await waitFor(async () => {
    try {
      return (await fetch(`${started.endpoint}/healthz`)).status === 200;
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  }, 4_000);
  return started;
}

async function rawRequest(port: number, request: string): Promise<string> {
  const client = createConnection({ host: "127.0.0.1", port });
  clients.push(client);
  client.setEncoding("utf8");
  let response = "";
  client.on("data", (chunk: string) => { response += chunk; });
  await once(client, "connect");
  client.end(request);
  await once(client, "close");
  return response;
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

async function waitFor(condition: () => boolean | Promise<boolean>, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for scheduler state");
}

async function within<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), timeout))
  ]);
}
