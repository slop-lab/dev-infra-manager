import { createServer, type RequestListener } from "node:http";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { openWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannel.js";
import { maintainWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannelReconnect.js";
import { workspaceServiceCleanup } from "../../../packages/host/core/src/workspace/serviceChannelGuest.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(handler?: RequestListener) {
  let current = true;
  const received: Buffer[] = [];
  const server = createServer(handler ?? ((request, response) => {
    request.on("data", (chunk: Buffer) => received.push(chunk));
    request.on("end", () => { response.setHeader("content-type", "text/event-stream"); response.write("data: first\n\n"); response.end("data: last\n\n"); });
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener missing");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  const runner = new ProcessRunner();
  const token = randomBytes(32).toString("base64url");
  const open = (signal: AbortSignal) => openWorkspaceServiceChannel({
    exec: (command, options) => runner.runStreaming(command[0] ?? "node", command.slice(1), options),
    current: async () => current, resolve: async (name) => name === "fixture" ? `http://127.0.0.1:${address.port}` : undefined,
    token, port: 0, signal,
  });
  const channel = open(new AbortController().signal);
  cleanup.push(() => channel.close());
  const port = await channel.ready;
  return { endpoint: `http://127.0.0.1:${port}`, received, expire() { current = false; }, channel, open,
    kill: () => runner.runStreaming("node", ["--input-type=commonjs", "-e", workspaceServiceCleanup, token]),
  };
}

it("streams guest HTTP upload and SSE over the host-initiated stdio channel", async () => {
  const fx = await fixture();
  const body = "pack".repeat(1024 * 256);
  const response = await fetch(`${fx.endpoint}/services/fixture/v1/responses`, { method: "POST", body });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
  expect(Buffer.concat(fx.received).toString()).toBe(body);
});

it("rejects unknown service names without exposing arbitrary host targets", async () => {
  const fx = await fixture();
  const response = await fetch(`${fx.endpoint}/services/unknown/http://127.0.0.1/admin`);
  expect(response.status).toBe(404); await response.body?.cancel();
  expect(fx.received).toHaveLength(0);
});

it("rejects streams after immutable workspace liveness expires", async () => {
  const fx = await fixture(); fx.expire();
  const response = await fetch(`${fx.endpoint}/services/fixture/read`);
  expect(response.status).toBe(410); await response.body?.cancel();
  expect(fx.received).toHaveLength(0);
});

it("closes the owned guest listener when the stdio channel ends", async () => {
  const fx = await fixture(); await fx.channel.close();
  await expect(fetch(`${fx.endpoint}/services/fixture/read`)).rejects.toThrow();
});

it("delivers SSE before completion and cancels the upstream when the guest caller aborts", async () => {
  let resolveClosed: () => void = () => {};
  const upstreamClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const fx = await fixture((_request, response) => {
    response.setHeader("content-type", "text/event-stream"); response.write("data: first\n\n");
    response.once("close", resolveClosed);
  });
  const controller = new AbortController();
  const response = await fetch(`${fx.endpoint}/services/fixture/stream`, { signal: controller.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream missing");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
  controller.abort();
  await expect(reader.read()).rejects.toThrow();
  await upstreamClosed;
});

it("preserves an upstream aborted stream as failure rather than successful truncated EOF", async () => {
  let abort: () => void = () => {};
  const fx = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n");
    abort = () => response.destroy();
  });
  const response = await fetch(`${fx.endpoint}/services/fixture/stream`), reader = response.body?.getReader();
  if (!reader) throw new Error("stream missing");
  await reader.read(); abort();
  await expect(reader.read()).rejects.toThrow();
});

it("reconnects a killed owned helper without replaying requests or replacing the host lifetime", async () => {
  const fx = await fixture(); await fx.channel.close();
  const events = new EventEmitter(), controller = new AbortController();
  const first = once(events, "ready");
  const running = maintainWorkspaceServiceChannel({ open: () => fx.open(controller.signal), signal: controller.signal,
    ready: async (port) => { events.emit("ready", port); }, disconnected: () => {}, report: () => {},
  });
  cleanup.push(async () => { controller.abort(); await running; });
  const [firstPort] = await first;
  const before = await fetch(`http://127.0.0.1:${firstPort}/services/fixture/read`);
  expect(before.status).toBe(200); await before.body?.cancel();
  const second = once(events, "ready");
  expect(await fx.kill()).toBe(0);
  const [secondPort] = await second;
  const after = await fetch(`http://127.0.0.1:${secondPort}/services/fixture/read`);
  expect(after.status).toBe(200); await after.body?.cancel();
  expect(controller.signal.aborted).toBe(false);
});

it("ignores unreadable unrelated proc entries while killing only the exact owned helper", () => {
  const killed: number[] = [];
  const fs = { readdirSync: () => ["11", "12", "13"], readFileSync: (file: string) => {
    if (file === "/proc/11/cmdline") throw Object.assign(new Error("process changed during inspection"), { code: "EIO" });
    return file === "/proc/12/cmdline" ? "node\0source\0dim-workspace-service-channel\0owned\0" : "node\0unrelated\0";
  } };
  expect(() => runInNewContext(workspaceServiceCleanup, { require: () => fs, process: { argv: ["node", "owned"], kill: (pid: number) => killed.push(pid) } })).not.toThrow();
  expect(killed).toEqual([12]);
});
