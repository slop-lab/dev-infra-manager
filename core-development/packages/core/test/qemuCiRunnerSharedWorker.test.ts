import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QEMU_CI_WEBHOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerWebhookAsset.js";

const roots: string[] = [];
const processes: ChildProcess[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.exitCode === null) process.kill("SIGKILL");
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared QEMU scheduler worker", () => {
  it.each(["disconnect", "malformed", "timeout"])("terminates, reaps, and releases after an uncertain %s renewal without passing scheduler credentials", async (renewalFailure) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-shared-worker-"));
    roots.push(root);
    const started = join(root, "started");
    const terminated = join(root, "terminated");
    const released = join(root, "released");
    const supervise = join(root, "supervise.bash");
    await writeFile(supervise, `#!/usr/bin/env bash
set -eu
[[ -z "\${DIM_QEMU_SCHEDULER_TOKEN:-}" ]]
printf '%s' "$$" >${JSON.stringify(started)}
trap 'touch ${JSON.stringify(terminated)}; exit 0' TERM
while true; do sleep 0.05; done
`);
    let claimed = false;
    const server = createServer((request, response) => {
      if (request.url === "/v1/claims") {
        if (claimed) {
          response.writeHead(204).end();
          return;
        }
        claimed = true;
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jobId: 501, claimId: "claim-one", leaseExpiresAt: 9999999999, leaseSeconds: 60 }));
        return;
      }
      if (request.url === "/v1/claims/claim-one/renew") {
        if (renewalFailure === "disconnect") request.socket.destroy();
        else if (renewalFailure === "malformed") response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ state: "unexpected" }));
        return;
      }
      if (request.url === "/v1/claims/claim-one/release") {
        void writeFile(released, "released");
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing worker fixture address");
    const readinessPort = await availablePort();
    const script = QEMU_CI_WEBHOOK_SCRIPT
      .replaceAll("/usr/local/bin/dim-qemu-ci-supervise", supervise)
      .replace("/var/lib/dim-qemu-ci/runs", join(root, "runs"))
      .replace('(\"0.0.0.0\", 8080)', `(\"127.0.0.1\", ${readinessPort})`);
    const scriptPath = join(root, "worker.py");
    await writeFile(scriptPath, script);
    const worker = spawn("python3", [scriptPath], {
      env: {
        ...process.env,
        DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer local-readiness",
        DIM_QEMU_CI_CAPACITY: "capacity",
        DIM_QEMU_CI_LABELS: "dim-qemu",
        DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05",
        DIM_QEMU_SCHEDULER_ENDPOINT: `http://127.0.0.1:${address.port}`,
        DIM_QEMU_SCHEDULER_PROJECT_ID: "project-id",
        DIM_QEMU_SCHEDULER_HOST_ID: "host-a",
        DIM_QEMU_SCHEDULER_TOKEN: "scheduler-secret"
      },
      stdio: "ignore"
    });
    processes.push(worker);

    // When
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${readinessPort}/healthz`, {
          headers: { Authorization: "Bearer local-readiness" }
        })).status === 200;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    });
    await waitFor(async () => exists(started));
    await waitFor(async () => exists(terminated));
    await waitFor(async () => exists(released));

    // Then
    const childPid = Number(await readFile(started, "utf8"));
    expect(await exists(`/proc/${childPid}`)).toBe(false);
    worker.kill("SIGTERM");
    await once(worker, "exit");
  }, 15_000);

  it("keeps a detached supervisor alive beyond its original monotonic lease deadline", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-shared-detached-"));
    roots.push(root);
    const started = join(root, "started");
    const terminated = join(root, "terminated");
    const finish = join(root, "finish");
    const released = join(root, "released");
    const supervise = join(root, "supervise.bash");
    await writeFile(supervise, `#!/usr/bin/env bash
set -eu
touch ${JSON.stringify(started)}
trap 'touch ${JSON.stringify(terminated)}; exit 0' TERM
while [[ ! -f ${JSON.stringify(finish)} ]]; do sleep 0.02; done
`);
    let claimed = false;
    const scheduler = createServer((request, response) => {
      if (request.url === "/v1/claims") {
        if (claimed) response.writeHead(204).end();
        else {
          claimed = true;
          response.writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ jobId: 601, claimId: "claim-detached", leaseExpiresAt: 9999999999, leaseSeconds: 60 }));
        }
        return;
      }
      if (request.url === "/v1/claims/claim-detached/renew") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ state: "detached" }));
        return;
      }
      if (request.url === "/v1/claims/claim-detached/release") {
        void writeFile(released, "released");
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(scheduler);
    scheduler.listen(0, "127.0.0.1");
    await once(scheduler, "listening");
    const address = scheduler.address();
    if (address === null || typeof address === "string") throw new Error("missing detached fixture address");
    const readinessPort = await availablePort();
    const scriptPath = join(root, "worker.py");
    await writeFile(scriptPath, QEMU_CI_WEBHOOK_SCRIPT
      .replaceAll("/usr/local/bin/dim-qemu-ci-supervise", supervise)
      .replace("/var/lib/dim-qemu-ci/runs", join(root, "runs"))
      .replace('lease_deadline = claim_started + lease["leaseSeconds"]', "lease_deadline = claim_started + 0.1")
      .replace('(\"0.0.0.0\", 8080)', `(\"127.0.0.1\", ${readinessPort})`));
    const worker = spawn("python3", [scriptPath], {
      env: {
        ...process.env,
        DIM_QEMU_WEBHOOK_AUTHORIZATION: "Bearer local-readiness",
        DIM_QEMU_CI_CAPACITY: "capacity",
        DIM_QEMU_CI_LABELS: "dim-qemu",
        DIM_QEMU_SCHEDULER_HEARTBEAT_SECONDS: "0.05",
        DIM_QEMU_SCHEDULER_ENDPOINT: `http://127.0.0.1:${address.port}`,
        DIM_QEMU_SCHEDULER_PROJECT_ID: "project-id",
        DIM_QEMU_SCHEDULER_HOST_ID: "host-a",
        DIM_QEMU_SCHEDULER_TOKEN: "scheduler-secret"
      },
      stdio: "ignore"
    });
    processes.push(worker);

    // When
    await waitFor(async () => exists(started));
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Then
    expect(await exists(terminated)).toBe(false);
    await writeFile(finish, "finish");
    await waitFor(async () => exists(released));
    worker.kill("SIGTERM");
    await once(worker, "exit");
  }, 15_000);

  it("holds an expired lease through cleanup grace and fences its prior owner after release", () => {
    // Given / When
    const assets = join(import.meta.dirname, "../../../../core/packages/core/src/shared-qemu-scheduler-assets");
    const result = spawnSync("python3", ["-c", `
import pathlib, tempfile
from protocol import HostId, ProjectId
from store import SchedulerStore
now = [1000.0]
with tempfile.TemporaryDirectory() as root:
    store = SchedulerStore(pathlib.Path(root) / "state.sqlite3", 60, lambda: now[0], takeover_grace_seconds=20, restart_hold_seconds=20)
    store.record_event(ProjectId("project"), "queued", 77, ("dim-qemu",))
    first = store.claim(ProjectId("project"), HostId("host-a"), "one", ("dim-qemu",), "request-a")
    now[0] = 1061.0
    second = store.claim(ProjectId("project"), HostId("host-b"), "two", ("dim-qemu",), "request-b")
    assert first is not None and second is None
    assert store.release(ProjectId("project"), HostId("host-a"), first.claim_id) is True
    successor = store.claim(ProjectId("project"), HostId("host-b"), "two", ("dim-qemu",), "request-c")
    assert successor is not None and first.claim_id != successor.claim_id
    assert store.release(ProjectId("project"), HostId("host-a"), first.claim_id) is False
`], { env: { ...process.env, PYTHONPATH: assets }, encoding: "utf8" });

    // Then
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("applies a one-time restart hold without reviving terminal demand", () => {
    const assets = join(import.meta.dirname, "../../../../core/packages/core/src/shared-qemu-scheduler-assets");
    const result = spawnSync("python3", ["-c", `
import pathlib, tempfile
from protocol import HostId, ProjectId
from store import SchedulerStore
now = [1000.0]
with tempfile.TemporaryDirectory() as root:
    path = pathlib.Path(root) / "state.sqlite3"
    store = SchedulerStore(path, 60, lambda: now[0], takeover_grace_seconds=20, restart_hold_seconds=20)
    store.record_event(ProjectId("project"), "queued", 77, ("dim-qemu",))
    first = store.claim(ProjectId("project"), HostId("host-a"), "one", ("dim-qemu",), "request-a")
    assert first is not None
    now[0] = 1061.0
    restarted = SchedulerStore(path, 60, lambda: now[0], takeover_grace_seconds=20, restart_hold_seconds=20)
    assert restarted.claim(ProjectId("project"), HostId("host-b"), "two", ("dim-qemu",), "request-b") is None
    now[0] = 900.0
    assert restarted.renew(ProjectId("project"), HostId("host-a"), first.claim_id) == "renewed"
    now[0] = 1102.0
    assert restarted.claim(ProjectId("project"), HostId("host-b"), "two", ("dim-qemu",), "request-c") is None
    now[0] = 1142.0
    assert restarted.claim(ProjectId("project"), HostId("host-b"), "two", ("dim-qemu",), "request-e") is not None
    restarted.record_event(ProjectId("project"), "completed", 77, ("dim-qemu",))
    now[0] = 1163.0
    terminal_restart = SchedulerStore(path, 60, lambda: now[0], takeover_grace_seconds=20, restart_hold_seconds=20)
    assert terminal_restart.claim(ProjectId("project"), HostId("host-a"), "three", ("dim-qemu",), "request-d") is None
`], { env: { ...process.env, PYTHONPATH: assets }, encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("does not reuse a request ID after its terminal or expired claim is removed", () => {
    const assets = join(import.meta.dirname, "../../../../core/packages/core/src/shared-qemu-scheduler-assets");
    const result = spawnSync("python3", ["-c", `
import pathlib, tempfile
from protocol import HostId, ProjectId
from store import SchedulerStore
now = [1000.0]
with tempfile.TemporaryDirectory() as root:
    store = SchedulerStore(pathlib.Path(root) / "state.sqlite3", 60, lambda: now[0], takeover_grace_seconds=20)
    project, host = ProjectId("project"), HostId("host-a")
    store.record_event(project, "queued", 1, ("dim-qemu",))
    first = store.claim(project, host, "capacity", ("dim-qemu",), "terminal-request")
    assert first is not None
    store.record_event(project, "completed", 1, ("dim-qemu",))
    assert store.release(project, host, first.claim_id)
    store.record_event(project, "queued", 2, ("dim-qemu",))
    assert store.claim(project, host, "capacity", ("dim-qemu",), "terminal-request") is None
    second = store.claim(project, host, "capacity", ("dim-qemu",), "expired-request")
    assert second is not None
    now[0] = 1081.0
    store.record_event(project, "queued", 3, ("dim-qemu",))
    assert store.claim(project, host, "capacity", ("dim-qemu",), "expired-request") is None
`], { env: { ...process.env, PYTHONPATH: assets }, encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects a service lease shorter than the worker safety contract", () => {
    const assets = join(import.meta.dirname, "../../../../core/packages/core/src/shared-qemu-scheduler-assets");
    const result = spawnSync("python3", ["-c", `
import json, pathlib, tempfile
from protocol import ProtocolError, load_config
with tempfile.TemporaryDirectory() as root:
    path = pathlib.Path(root) / "config.json"
    path.write_text(json.dumps({"schemaVersion": 1, "listen": {"host": "127.0.0.1", "port": 1}, "database": str(pathlib.Path(root) / "db"), "leaseSeconds": 59, "projects": {"project": {"webhookToken": "webhook", "apiToken": "service", "labels": ["dim-qemu"]}}}))
    path.chmod(0o600)
    try:
        load_config(path)
    except ProtocolError:
        pass
    else:
        raise AssertionError("unsafe lease was accepted")
`], { env: { ...process.env, PYTHONPATH: assets }, encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for shared worker fixture");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing available port fixture address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
