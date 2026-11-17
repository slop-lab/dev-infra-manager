import dgram from "node:dgram";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startGuestNameService, DIM_NAME_SERVICE_INGRESS_PORT, type GuestNameServiceHandle, type WorkspaceNameTable } from "@slop-lab/dim-host-core/workspace";

const roots: string[] = [];
const handles: GuestNameServiceHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(table: WorkspaceNameTable, resolvConf = "nameserver 9.9.9.9\nnameserver 9.9.9.8\n") {
  const root = await mkdtemp(join(tmpdir(), "dim-name-service-guest-"));
  roots.push(root);
  const configPath = join(root, "config.json"), resolvConfPath = join(root, "resolv.conf");
  await writeFile(configPath, JSON.stringify(table));
  await writeFile(resolvConfPath, resolvConf);
  return { root, configPath, resolvConfPath };
}

async function upstreamServer(body: string) {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("upstream unavailable");
  return { port: address.port, close: () => server.close() };
}

async function udpQuery(port: number, name: string, qtype = 1, timeoutMs = 1_000): Promise<Buffer | undefined> {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x55aa, 0); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const question = Buffer.concat([...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0])]);
  const tail = Buffer.alloc(4); tail.writeUInt16BE(qtype, 0); tail.writeUInt16BE(1, 2);
  const query = Buffer.concat([header, question, tail]);
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<Buffer | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      socket.once("message", (message) => { clearTimeout(timer); resolve(message); });
      socket.send(query, port, "127.0.0.1");
    });
  } finally { socket.close(); }
}

function get(port: number, host: string): Promise<{ status: number; body(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      const ended = new Promise<string>((resolveBody) => { response.on("data", (c: Buffer) => chunks.push(c)); response.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8"))); });
      resolve({ status: response.statusCode ?? 0, body: () => ended });
    });
    request.on("error", reject); request.end();
  });
}

it("binds the guest resolver and ingress, answers registered names, and forwards HTTP by Host", async () => {
  const upstream = await upstreamServer("hello-from-cache");
  try {
    const table: WorkspaceNameTable = { "host-mirrors": [{ name: "npm.cache.dim.internal", upstream: `http://127.0.0.1:${upstream.port}/` }] };
    const { configPath, resolvConfPath } = await fixture(table);
    const handle = await startGuestNameService(configPath, { resolvConfPath, resolverPort: 0 });
    handles.push(handle);

    const answer = await udpQuery(handle.resolverPort, "npm.cache.dim.internal");
    if (!answer) throw new Error("expected a DNS answer");
    expect(answer.readUInt16BE(6)).toBe(1);
    expect(answer.subarray(answer.length - 4)).toEqual(Buffer.from([127, 0, 0, 1]));

    expect(handle.ingressPort).toBe(DIM_NAME_SERVICE_INGRESS_PORT);
    const response = await get(handle.ingressPort, "npm.cache.dim.internal");
    expect(response.status).toBe(200);
    expect(await response.body()).toBe("hello-from-cache");
  } finally { upstream.close(); }
});

it("answers NXDOMAIN for an unregistered name and never resolves it even though *.dim.internal", async () => {
  const { configPath, resolvConfPath } = await fixture({});
  const handle = await startGuestNameService(configPath, { resolvConfPath, resolverPort: 0 });
  handles.push(handle);
  const answer = await udpQuery(handle.resolverPort, "unregistered.dim.internal");
  if (!answer) throw new Error("expected a response");
  expect(answer.readUInt16BE(2) & 0xF).toBe(3);
});

it("captures the original resolv.conf, points it at the local resolver, and reverts it on close", async () => {
  const original = "nameserver 9.9.9.9\nnameserver 9.9.9.8\n";
  const { configPath, resolvConfPath } = await fixture({}, original);
  const handle = await startGuestNameService(configPath, { resolvConfPath, resolverPort: 0 });
  handles.push(handle);

  const applied = await readFile(resolvConfPath, "utf8");
  expect(applied).toContain("nameserver 127.0.0.1");
  expect(applied).not.toContain("9.9.9.9");
  const backup = await readFile(join(configPath, "..", "resolv-conf.backup"), "utf8");
  expect(backup).toBe(original);

  await handle.close(); // afterEach calls close() again; it is idempotent
  expect(await readFile(resolvConfPath, "utf8")).toBe(original);
  await expect(readFile(join(configPath, "..", "resolv-conf.backup"), "utf8")).rejects.toThrow();
});

it("forwards non-dim.internal queries to the resolvers captured from the original resolv.conf, not 127.0.0.1", async () => {
  const upstreamDns = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  upstreamDns.on("message", (message, remote) => {
    received.push(message);
    const reply = Buffer.from(message); reply.writeUInt16BE(0x8180, 2); // QR=1, RA=1, NOERROR
    upstreamDns.send(reply, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => upstreamDns.bind(0, "127.0.0.1", resolve));
  const address = upstreamDns.address();
  if (typeof address === "string") throw new Error("fake upstream unavailable");
  try {
    const { configPath, resolvConfPath } = await fixture({}, `nameserver 127.0.0.1:${address.port}\n`);
    const handle = await startGuestNameService(configPath, { resolvConfPath, resolverPort: 0 });
    handles.push(handle);
    const answer = await udpQuery(handle.resolverPort, "www.example.com");
    expect(answer).toBeDefined();
    expect(received.length).toBe(1);
  } finally { upstreamDns.close(); }
});

it("picks up a growing name table without restarting, via its own poll loop", async () => {
  const upstream = await upstreamServer("added-later");
  try {
    const { configPath, resolvConfPath } = await fixture({});
    const handle = await startGuestNameService(configPath, { resolvConfPath, resolverPort: 0 });
    handles.push(handle);
    expect(await udpQuery(handle.resolverPort, "late.dim.internal")).toSatisfy((buffer: Buffer | undefined) => buffer !== undefined && (buffer.readUInt16BE(2) & 0xF) === 3);
    await writeFile(configPath, JSON.stringify({ owner: [{ name: "late.dim.internal", upstream: `http://127.0.0.1:${upstream.port}/` }] }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const answer = await udpQuery(handle.resolverPort, "late.dim.internal");
    expect(answer).toBeDefined();
    expect(answer!.readUInt16BE(6)).toBe(1);
  } finally { upstream.close(); }
});

it("rejects a relative configuration path", async () => {
  await expect(startGuestNameService("relative.json")).rejects.toThrow(/absolute/);
});
