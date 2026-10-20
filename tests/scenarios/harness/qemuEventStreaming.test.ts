import { spawn, type ChildProcessByStdio } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startService } from "./qemuServiceTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const clientScript = resolve(workspaceRoot, "tests/scenarios/qemu/qemu-client.mts");
const servers: Server[] = [];
const roots: string[] = [];

type CliResult = { readonly exitCode: number | null; readonly stderr: string; readonly stdout: string };

function runClient(socketPath: string, command: "run" | "status"): Promise<CliResult> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [clientScript, command], {
    env: { ...process.env, DIM_QEMU_VERIFICATION_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("close", (exitCode) => resolveResult({
      exitCode,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
  });
}

async function truncatedServer(route: "/v1/events" | "/v1/status"): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-client-test-"));
  await chmod(root, 0o755);
  roots.push(root);
  const socketPath = resolve(root, "service.sock");
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/run") {
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}\n");
      return;
    }
    if (request.url === route) {
      response.writeHead(200, { "content-type": route === "/v1/events" ? "text/plain" : "application/json" });
      response.flushHeaders();
      response.write(route === "/v1/events" ? "partial event\n" : '{"status":"succ');
      setImmediate(() => response.socket?.destroy());
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"success"}\n');
  });
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  return socketPath;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU event streaming CLI", () => {
  it("delivers complete output and reports a normal guest failure as exit 1", async () => {
    // Given
    const outputBytes = 4_096;
    const fixture = await startService("exit", { launcherExitCode: 7, launcherOutputBytes: outputBytes });

    // When
    const result = await runClient(fixture.socketPath, "run");

    // Then
    expect.soft(result.exitCode).toBe(1);
    expect.soft(result.stderr).toBe("");
    expect(result.stdout).toBe(`ready\n${"x".repeat(outputBytes)}`);
  });

  it("delivers a complete healthy burst after HTTP backpressure", async () => {
    // Given
    const outputBytes = 2 * 1024 * 1024;
    const fixture = await startService("exit", { launcherOutputBytes: outputBytes });

    // When
    const result = await runClient(fixture.socketPath, "run");

    // Then
    expect.soft(result.exitCode).toBe(0);
    expect.soft(result.stderr).toBe("");
    expect(result.stdout).toBe(`ready\n${"x".repeat(outputBytes)}`);
  });

  it("fails concisely instead of exiting 13 when the event response is truncated", async () => {
    // Given
    const socketPath = await truncatedServer("/v1/events");

    // When
    const result = await runClient(socketPath, "run");

    // Then
    expect.soft(result.exitCode).toBe(1);
    expect.soft(result.stdout).toBe("partial event\n");
    expect(result.stderr).toBe("QEMU event stream ended before completion\n");
  });

  it("fails concisely instead of exiting 13 when a buffered response is truncated", async () => {
    // Given
    const socketPath = await truncatedServer("/v1/status");

    // When
    const result = await runClient(socketPath, "status");

    // Then
    expect.soft(result.exitCode).toBe(1);
    expect.soft(result.stdout).toBe("");
    expect(result.stderr).toBe("QEMU response ended before completion\n");
  });
});
