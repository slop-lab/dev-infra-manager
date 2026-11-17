import dgram from "node:dgram";
import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { createNameResolver, type NameResolverHandle } from "@slop-lab/dim-host-core/workspace";

const handles: NameResolverHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); });

function encodeQuery(name: string, qtype: number, id = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0); header.writeUInt16BE(0x0100, 2); // standard query, recursion desired
  header.writeUInt16BE(1, 4);
  const labels = name === "" ? [] : name.split(".");
  const question = Buffer.concat([
    ...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])),
    Buffer.from([0])
  ]);
  const tail = Buffer.alloc(4); tail.writeUInt16BE(qtype, 0); tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, question, tail]);
}

async function udpQuery(port: number, query: Buffer, timeoutMs = 1_000): Promise<Buffer | undefined> {
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<Buffer | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      socket.once("message", (message) => { clearTimeout(timer); resolve(message); });
      socket.send(query, port, "127.0.0.1");
    });
  } finally { socket.close(); }
}

async function fakeUpstream(answer: Buffer): Promise<{ readonly port: number; close: () => void }> {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, remote) => {
    const reply = Buffer.from(answer); reply.writeUInt16BE(message.readUInt16BE(0), 0);
    socket.send(reply, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (typeof address === "string") throw new Error("fake upstream unavailable");
  return { port: address.port, close: () => socket.close() };
}

async function resolver(names: ReadonlySet<string>, upstreams: readonly string[] = []) {
  const handle = await createNameResolver({ listen: "127.0.0.1", port: 0, gateway: "172.25.6.1", names: () => names, upstreams: () => upstreams });
  handles.push(handle);
  return handle;
}

it("answers a registered *.dim.internal A query with the workspace gateway", async () => {
  const handle = await resolver(new Set(["npm.cache.dim.internal"]));
  const response = await udpQuery(handle.udpPort, encodeQuery("npm.cache.dim.internal", 1));
  if (!response) throw new Error("expected a response");
  expect(response.readUInt16BE(0)).toBe(0x1234);
  expect((response.readUInt16BE(2) >> 15) & 1).toBe(1); // QR
  expect(response.readUInt16BE(2) & 0xF).toBe(0); // NOERROR
  expect(response.readUInt16BE(6)).toBe(1); // ANCOUNT
  expect(response.subarray(response.length - 4)).toEqual(Buffer.from([172, 25, 6, 1]));
});

it("answers NOERROR with no data for a registered name's AAAA query", async () => {
  const handle = await resolver(new Set(["npm.cache.dim.internal"]));
  const response = await udpQuery(handle.udpPort, encodeQuery("npm.cache.dim.internal", 28));
  if (!response) throw new Error("expected a response");
  expect(response.readUInt16BE(2) & 0xF).toBe(0); // NOERROR
  expect(response.readUInt16BE(6)).toBe(0); // ANCOUNT
});

it("answers NXDOMAIN for an unregistered *.dim.internal name", async () => {
  const handle = await resolver(new Set(["other.dim.internal"]));
  const response = await udpQuery(handle.udpPort, encodeQuery("npm.cache.dim.internal", 1));
  if (!response) throw new Error("expected a response");
  expect(response.readUInt16BE(2) & 0xF).toBe(3); // NXDOMAIN
  expect(response.readUInt16BE(6)).toBe(0);
});

it("forwards a query for any other domain to the configured upstream and relays its response verbatim", async () => {
  const canned = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0,
    3, 119, 119, 119, 7, 101, 120, 97, 109, 112, 108, 101, 3, 99, 111, 109, 0, 0, 1, 0, 1,
    0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 93, 184, 216, 34]);
  const upstream = await fakeUpstream(canned);
  try {
    const handle = await resolver(new Set(), [`127.0.0.1:${upstream.port}`]);
    const response = await udpQuery(handle.udpPort, encodeQuery("www.example.com", 1));
    if (!response) throw new Error("expected a forwarded response");
    expect(response.subarray(response.length - 4)).toEqual(Buffer.from([93, 184, 216, 34]));
  } finally { upstream.close(); }
});

it("never answers or forwards for an upstream-less resolver", async () => {
  const handle = await resolver(new Set(), []);
  const response = await udpQuery(handle.udpPort, encodeQuery("www.example.com", 1), 200);
  expect(response).toBeUndefined();
});

it("drops malformed packets without responding or forwarding", async () => {
  const handle = await resolver(new Set(["npm.cache.dim.internal"]));
  for (const malformed of [Buffer.alloc(0), Buffer.from([1, 2, 3]), Buffer.alloc(20, 0xFF)]) {
    const response = await udpQuery(handle.udpPort, malformed, 200);
    expect(response).toBeUndefined();
  }
});

it("answers a registered name over TCP using the two-byte length prefix", async () => {
  const handle = await resolver(new Set(["npm.cache.dim.internal"]));
  const query = encodeQuery("npm.cache.dim.internal", 1);
  const framed = Buffer.alloc(2 + query.length); framed.writeUInt16BE(query.length, 0); query.copy(framed, 2);
  const response = await new Promise<Buffer>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: handle.tcpPort }, () => socket.write(framed));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
    setTimeout(() => reject(new Error("TCP response timed out")), 2_000);
  });
  const message = response.subarray(2, 2 + response.readUInt16BE(0));
  expect(message.readUInt16BE(6)).toBe(1); // ANCOUNT
  expect(message.subarray(message.length - 4)).toEqual(Buffer.from([172, 25, 6, 1]));
});
