import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureManagedProxy,
  ManagedProxyError,
  managedProxyStatePath,
  type ManagedProxyCommand
} from "../../../../core/packages/controller-proxy/src/managed-proxy.js";
import { processStartTime } from "../../../../core/packages/controller-proxy/src/managed-process.js";

describe("managed controller proxy", () => {
  const roots: string[] = [];
  const pids = new Set<number>();
  const servers = new Set<net.Server>();

  afterEach(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    vi.restoreAllMocks();
    pids.clear();
    await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => error ? reject(error) : resolve());
    })));
    servers.clear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("serializes concurrent startup and reuses an identical healthy process", async () => {
    // Given
    const fixture = await managedFixture();

    // When
    const [first, second] = await Promise.all([
      ensureManagedProxy(fixture.options("policy-a")),
      ensureManagedProxy(fixture.options("policy-a"))
    ]);
    pids.add(first.pid);
    pids.add(second.pid);

    // Then
    expect(new Set([first.action, second.action])).toEqual(new Set(["started", "reused"]));
    expect(first.pid).toBe(second.pid);
  });

  it("restarts a managed process when trusted configuration changes without removing its directory", async () => {
    // Given
    const fixture = await managedFixture();
    const marker = path.join(path.dirname(fixture.listen), "mounted-marker");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "keep");
    const first = await ensureManagedProxy(fixture.options("policy-a"));
    pids.add(first.pid);

    // When
    const second = await ensureManagedProxy(fixture.options("policy-b"));
    pids.add(second.pid);

    // Then
    expect(second.action).toBe("restarted");
    expect(second.pid).not.toBe(first.pid);
    expect(await readFile(marker, "utf8")).toBe("keep");
  });

  it("bounds termination and replaces an owned process that ignores graceful shutdown", async () => {
    // Given
    const fixture = await managedFixture(true);
    const first = await ensureManagedProxy(fixture.options("policy-a"));
    pids.add(first.pid);

    // When
    const second = await ensureManagedProxy({
      ...fixture.options("policy-b"),
      terminationTimeoutMs: 100
    });
    pids.add(second.pid);

    // Then
    expect(second.action).toBe("restarted");
    expect(second.pid).not.toBe(first.pid);
  });

  it("refuses to signal a live process when its recorded start identity is invalid", async () => {
    // Given
    const fixture = await managedFixture();
    const first = await ensureManagedProxy(fixture.options("policy-a"));
    pids.add(first.pid);
    const statePath = managedProxyStatePath(fixture.listen);
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isObject(state)) throw new Error("expected managed proxy state object");
    await writeFile(statePath, `${JSON.stringify({ ...state, startTime: "0" })}\n`, { mode: 0o600 });

    // When / Then
    await expect(ensureManagedProxy(fixture.options("policy-b"))).rejects.toThrow(/identity/i);
    expect(() => process.kill(first.pid, 0)).not.toThrow();
  });

  it("bounds a socket probe that never settles", async () => {
    // Given
    const fixture = await managedFixture();
    const first = await ensureManagedProxy(fixture.options("policy-a"));
    pids.add(first.pid);
    vi.spyOn(net, "createConnection").mockImplementation(() => new net.Socket());

    // When / Then
    await expect(ensureManagedProxy({
      ...fixture.options("policy-a"),
      startupTimeoutMs: 100,
      terminationTimeoutMs: 100
    })).rejects.toThrow(/ready|probe/i);
  }, 1_000);

  it("reclaims an abandoned ownerless startup lock after its grace period", async () => {
    // Given
    const fixture = await managedFixture();
    const lockPath = `${fixture.listen}.ensure.lock`;
    await mkdir(lockPath, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    // When
    const result = await ensureManagedProxy({ ...fixture.options("policy-a"), startupTimeoutMs: 500 });
    pids.add(result.pid);

    // Then
    expect(result.action).toBe("started");
  });

  it("does not reclaim a fresh ownerless startup lock", async () => {
    // Given
    const fixture = await managedFixture();
    const lockPath = `${fixture.listen}.ensure.lock`;
    await mkdir(lockPath, { recursive: true });

    // When / Then
    await expect(ensureManagedProxy({ ...fixture.options("policy-a"), startupTimeoutMs: 50 }))
      .rejects.toThrow(/startup lock/i);
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("reports spawn errors without an unhandled child-process error", async () => {
    // Given
    const fixture = await managedFixture();
    const options = fixture.options("policy-a");

    // When / Then
    await expect(ensureManagedProxy({
      ...options,
      command: { ...options.command, executable: path.join(path.dirname(fixture.listen), "missing") }
    })).rejects.toBeInstanceOf(ManagedProxyError);
  });

  it("terminates the exact child when managed state persistence fails", async () => {
    // Given
    const fixture = await managedFixture(false, true);

    // When
    await expect(ensureManagedProxy(fixture.options("policy-a"))).rejects.toThrow();
    const pid = Number(await readFile(fixture.pidFile, "utf8"));
    pids.add(pid);

    // Then
    await expectProcessExit(pid);
  });

  it("does not accept a different listener as readiness for the managed PID", async () => {
    // Given
    const fixture = await managedFixture(false, false, false);
    await mkdir(path.dirname(fixture.listen), { recursive: true });
    const unrelated = net.createServer();
    servers.add(unrelated);
    await listenServer(unrelated, fixture.listen);
    const child = spawn(fixture.command.executable, fixture.command.arguments, {
      env: fixture.command.environment,
      stdio: "ignore"
    });
    if (child.pid === undefined) throw new Error("fixture child requires a PID");
    pids.add(child.pid);
    const startTime = await processStartTime(child.pid);
    if (startTime === undefined) throw new Error("fixture child requires start identity");
    await writeFile(managedProxyStatePath(fixture.listen), JSON.stringify({
      version: 1,
      pid: child.pid,
      startTime,
      fingerprint: "policy-a"
    }));

    // When / Then
    await expect(ensureManagedProxy({
      ...fixture.options("policy-a"),
      startupTimeoutMs: 100,
      terminationTimeoutMs: 100
    })).rejects.toThrow(/ready/i);
  });

  async function managedFixture(
    ignoreTermination = false,
    blockState = false,
    shouldListen = true
  ): Promise<{
    readonly listen: string;
    readonly pidFile: string;
    readonly command: ManagedProxyCommand;
    readonly options: (fingerprint: string) => {
      readonly listen: string;
      readonly fingerprint: string;
      readonly command: ManagedProxyCommand;
      readonly startupTimeoutMs: number;
      readonly terminationTimeoutMs: number;
    };
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "dim-managed-proxy-"));
    roots.push(root);
    const listen = path.join(root, "mounted", "controller.sock");
    const pidFile = path.join(root, "proxy.pid");
    const script = path.join(root, "proxy-fixture.mjs");
    await writeFile(script, [
      'import http from "node:http";',
      'import { rm } from "node:fs/promises";',
      'const socket = process.env.TEST_PROXY_SOCKET;',
      'if (!socket) throw new Error("TEST_PROXY_SOCKET is required");',
      'await writeFile(process.env.TEST_PID_FILE, String(process.pid));',
      'if (process.env.TEST_BLOCK_STATE === "true") await mkdir(`${socket}.managed.json`);',
      'const server = http.createServer((_request, response) => response.end("ok"));',
      'await rm(socket, { force: true });',
      'if (process.env.TEST_LISTEN === "true") server.listen(socket);',
      'process.on("SIGTERM", () => {',
      '  if (process.env.TEST_IGNORE_TERMINATION === "true") return;',
      '  server.close(() => void rm(socket, { force: true }).finally(() => process.exit(0)));',
      '});',
      'setInterval(() => undefined, 1_000);'
    ].join("\n").replace(
      'import { rm } from "node:fs/promises";',
      'import { mkdir, rm, writeFile } from "node:fs/promises";'
    ));
    const command: ManagedProxyCommand = {
      executable: process.execPath,
      arguments: [script],
      identityMarker: script,
      environment: {
        ...process.env,
        TEST_PROXY_SOCKET: listen,
        TEST_PID_FILE: pidFile,
        TEST_IGNORE_TERMINATION: String(ignoreTermination),
        TEST_BLOCK_STATE: String(blockState),
        TEST_LISTEN: String(shouldListen)
      }
    };
    return {
      listen,
      pidFile,
      command,
      options: (fingerprint) => ({
        listen,
        fingerprint,
        command,
        startupTimeoutMs: 2_000,
        terminationTimeoutMs: 1_000
      })
    };
  }
});

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected PID ${pid} to exit`);
}

function listenServer(server: net.Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
