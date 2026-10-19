import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { workspacePortBridge, workspacePortBridgeMarker, workspacePortCleanup } from "../../../../packages/host/core/src/workspace/portBridge.js";

describe("workspace loopback byte bridge", () => {
  it("preserves binary bytes and receives a response after the client half-closes", async () => {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    try {
      const input = Buffer.alloc(1024 * 1024 + 3);
      for (let index = 0; index < input.length; index++) input[index] = index % 256;
      const result = await bridge(address.port, input);
      expect(result.code).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toEqual(input);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("reports connection refusal only on stderr without protocol bytes", async () => {
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await bridge(address.port, Buffer.alloc(0));
    expect(result.code).toBe(1); expect(result.stdout.length).toBe(0); expect(result.stderr).toContain("ECONNREFUSED");
  });

  it("releases the target connection when the bridge is terminated", async () => {
    let connected: Socket | undefined;
    const server = createServer((socket) => { connected = socket; });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspacePortBridge, String(address.port)], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await once(server, "connection");
      const closed = once(connected!, "close");
      child.kill("SIGTERM"); await once(child, "close"); await closed;
    } finally {
      child.kill("SIGKILL"); connected?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("cleans up only the matching connection, including a process ignoring termination", async () => {
    const token = `test-${process.pid}-${Date.now()}`;
    const script = 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)';
    const owned = spawn(process.execPath, ["-e", script, workspacePortBridgeMarker, token]);
    const unrelated = spawn(process.execPath, ["-e", script, workspacePortBridgeMarker, token + "-other"]);
    try {
      await Promise.all([once(owned.stdout!, "data"), once(unrelated.stdout!, "data")]);
      const exited = once(owned, "close");
      const cleanup = spawn(process.execPath, ["-e", workspacePortCleanup, token]);
      let errors = ""; cleanup.stderr!.on("data", (chunk) => { errors += String(chunk); });
      const [code] = await once(cleanup, "close");
      expect(errors).toBe(""); expect(code).toBe(0);
      await exited; expect(unrelated.exitCode).toBe(null); expect(unrelated.signalCode).toBe(null);
    } finally { owned.kill("SIGKILL"); unrelated.kill("SIGKILL"); }
  });

});

async function bridge(port: number, input: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e", workspacePortBridge, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = []; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, stdout: Buffer.concat(chunks), stderr };
}
