import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "../../../../core/images/project-workspace/agent-git-relay.mjs");
const holderScript = join(import.meta.dirname, "fixtures/agentGitRelayEnsureHolder.mjs");
const roots: string[] = [];
const environments: NodeJS.ProcessEnv[] = [];

afterEach(async () => {
  await Promise.all(environments.splice(0).map((env) => run(process.execPath, [script, "stop"], { env }).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reuses an attested owned listener and restarts it when configuration changes", async () => {
  // Given
  const upstream = http.createServer((_request, response) => response.writeHead(200).end());
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  if (upstreamAddress === null || typeof upstreamAddress === "string") throw new TypeError("upstream has no TCP address");
  const reservation = http.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const relayAddress = reservation.address();
  if (relayAddress === null || typeof relayAddress === "string") throw new TypeError("reservation has no TCP address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-owner-"));
  roots.push(root);
  const environment = {
    ...process.env,
    DIM_AGENT_GIT_RELAY_MODE: "native",
    DIM_AGENT_GIT_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
    DIM_AGENT_GIT_PATH: "/project/root.git",
    DIM_AGENT_GIT_LISTEN_HOST: "127.0.0.1",
    DIM_AGENT_GIT_LISTEN_PORT: String(relayAddress.port),
    DIM_AGENT_GIT_STATE_DIR: root,
    DIM_AGENT_GIT_INITIAL_PHASE: "setting-up"
  };
  environments.push(environment);

  // When
  const first = JSON.parse((await run(process.execPath, [script, "ensure"], { env: environment })).stdout) as unknown;
  const second = JSON.parse((await run(process.execPath, [script, "ensure"], { env: environment })).stdout) as unknown;
  const changed = { ...environment, DIM_AGENT_GIT_PATH: "/project/other.git" };
  environments.push(changed);
  const third = JSON.parse((await run(process.execPath, [script, "ensure"], { env: changed })).stdout) as unknown;

  // Then
  expect(first).toMatchObject({ status: "ready", host: "127.0.0.1", port: relayAddress.port });
  expect(second).toEqual(first);
  expect(third).toMatchObject({ status: "ready", host: "127.0.0.1", port: relayAddress.port });
  expect(Reflect.get(third as object, "pid")).not.toBe(Reflect.get(first as object, "pid"));
  await run(process.execPath, [script, "stop"], { env: changed });
  await new Promise<void>((resolve, reject) => upstream.close((error) => error === undefined ? resolve() : reject(error)));
}, 15_000);

it("refuses to adopt or stop a foreign listener", async () => {
  // Given
  const foreign = http.createServer((_request, response) => response.writeHead(204).end());
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const address = foreign.address();
  if (address === null || typeof address === "string") throw new TypeError("foreign listener has no TCP address");
  const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-foreign-"));
  roots.push(root);
  const environment = {
    ...process.env,
    DIM_AGENT_GIT_RELAY_MODE: "native",
    DIM_AGENT_GIT_UPSTREAM: "http://127.0.0.1:1",
    DIM_AGENT_GIT_PATH: "/project/root.git",
    DIM_AGENT_GIT_LISTEN_HOST: "127.0.0.1",
    DIM_AGENT_GIT_LISTEN_PORT: String(address.port),
    DIM_AGENT_GIT_STATE_DIR: root,
    DIM_AGENT_GIT_INITIAL_PHASE: "setting-up"
  };

  // When / Then
  await expect(run(process.execPath, [script, "ensure"], { env: environment })).rejects.toThrow(/exited before readiness/);
  await expect(new Promise<number>((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port: address.port }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolve(incoming.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  })).resolves.toBe(204);
  await new Promise<void>((resolve, reject) => foreign.close((error) => error === undefined ? resolve() : reject(error)));
});

it("reclaims an ensure lock after its exact holder is killed", async () => {
  // Given
  const fixture = await ownershipFixture();
  const holder = spawn(process.execPath, [holderScript], { env: fixture.environment, stdio: "ignore" });
  await waitForLock(fixture.root);
  holder.kill("SIGKILL");
  await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

  // When
  const result = JSON.parse((await run(process.execPath, [script, "ensure"], {
    env: fixture.environment
  })).stdout) as unknown;

  // Then
  expect(result).toMatchObject({ status: "ready", port: fixture.port });
  await run(process.execPath, [script, "stop"], { env: fixture.environment });
}, 10_000);

it("reclaims an ensure lock when the PID start identity was reused", async () => {
  // Given
  const fixture = await ownershipFixture();
  const lock = join(fixture.root, "ensure.lock");
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    processStart: "0",
    nonce: "b".repeat(43),
    configHash: "f".repeat(64)
  })}\n`, { mode: 0o600 });

  // When
  const result = JSON.parse((await run(process.execPath, [script, "ensure"], {
    env: fixture.environment
  })).stdout) as unknown;

  // Then
  expect(result).toMatchObject({ status: "ready", port: fixture.port });
  await run(process.execPath, [script, "stop"], { env: fixture.environment });
});

it("refuses to steal an ensure lock from a live process instance", async () => {
  // Given
  const fixture = await ownershipFixture();
  const lock = join(fixture.root, "ensure.lock");
  const start = await processStart(process.pid);
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    processStart: start,
    nonce: "c".repeat(43),
    configHash: "e".repeat(64)
  };
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });

  // When / Then
  await expect(run(process.execPath, [script, "ensure"], { env: fixture.environment }))
    .rejects.toThrow(/live process|lock is busy/);
  await expect(readFile(join(lock, "owner.json"), "utf8")).resolves.toBe(`${JSON.stringify(owner)}\n`);
}, 10_000);

async function ownershipFixture(): Promise<{
  readonly root: string;
  readonly port: number;
  readonly environment: NodeJS.ProcessEnv;
}> {
  const reservation = http.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (address === null || typeof address === "string") throw new TypeError("reservation has no TCP address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const root = await mkdtemp(join(tmpdir(), "dim-agent-relay-lock-"));
  roots.push(root);
  const environment = {
    ...process.env,
    DIM_AGENT_GIT_RELAY_MODE: "native",
    DIM_AGENT_GIT_UPSTREAM: "http://127.0.0.1:1",
    DIM_AGENT_GIT_PATH: "/project/root.git",
    DIM_AGENT_GIT_LISTEN_HOST: "127.0.0.1",
    DIM_AGENT_GIT_LISTEN_PORT: String(address.port),
    DIM_AGENT_GIT_STATE_DIR: root,
    DIM_AGENT_GIT_INITIAL_PHASE: "setting-up"
  };
  environments.push(environment);
  return { root, port: address.port, environment };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`file did not appear: ${path}`);
}

async function waitForLock(root: string): Promise<void> {
  for (const name of ["owner.json", "pid"]) {
    try {
      await waitForFile(join(root, "ensure.lock", name));
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("file did not appear:")) throw error;
    }
  }
  throw new Error("ensure lock owner did not appear");
}

async function processStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (start === undefined) throw new Error("process start identity is unavailable");
  return start;
}
