import dgram from "node:dgram";
import net, { type Socket } from "node:net";
import { DIM_INTERNAL_SUFFIX } from "./nameRegistration.js";

const MAX_MESSAGE = 4096;

export interface ParsedDnsQuery { readonly id: number; readonly qname: string; readonly qtype: number; readonly questionEnd: number; readonly recursionDesired: boolean }

/** Minimal wire parse: a single standard query question, no compression. Anything else is malformed. */
export function parseDnsQuery(buffer: Buffer): ParsedDnsQuery | undefined {
  if (buffer.length < 12 || buffer.length > MAX_MESSAGE) return undefined;
  const flags = buffer.readUInt16BE(2);
  if ((flags >> 15) & 1) return undefined; // a response, not a query
  if ((flags >> 11) & 0xF) return undefined; // only standard queries
  if (buffer.readUInt16BE(4) !== 1) return undefined; // exactly one question
  let offset = 12, length = 0;
  const labels: string[] = [];
  for (;;) {
    if (offset >= buffer.length) return undefined;
    const size = buffer.readUInt8(offset);
    if ((size & 0xC0) !== 0) return undefined; // no compression pointers in a fresh query
    if (size === 0) { offset += 1; break; }
    if (size > 63 || offset + 1 + size > buffer.length) return undefined;
    labels.push(buffer.toString("latin1", offset + 1, offset + 1 + size));
    length += size + 1;
    if (length > 253) return undefined;
    offset += 1 + size;
  }
  if (offset + 4 > buffer.length) return undefined;
  const qtype = buffer.readUInt16BE(offset), qclass = buffer.readUInt16BE(offset + 2);
  if (qclass !== 1) return undefined; // IN only
  return { id: buffer.readUInt16BE(0), qname: labels.join(".").toLowerCase(), qtype, questionEnd: offset + 4, recursionDesired: !!((flags >> 8) & 1) };
}

/** Copies the original question verbatim and appends A records via name compression to offset 12. */
export function encodeDnsResponse(query: Buffer, parsed: ParsedDnsQuery, rcode: number, answers: readonly { readonly ttl: number; readonly address: string }[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(parsed.id, 0);
  header.writeUInt16BE(0x8000 | 0x0400 | 0x0080 | (parsed.recursionDesired ? 0x0100 : 0) | (rcode & 0xF), 2);
  header.writeUInt16BE(1, 4); header.writeUInt16BE(answers.length, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  const question = query.subarray(12, parsed.questionEnd);
  const records = answers.map(({ ttl, address }) => {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xC00C, 0); record.writeUInt16BE(1, 2); record.writeUInt16BE(1, 4);
    record.writeUInt32BE(ttl, 6); record.writeUInt16BE(4, 10);
    const octets = address.split(".").map(Number);
    for (let i = 0; i < 4; i++) record.writeUInt8(octets[i] ?? 0, 12 + i);
    return record;
  });
  return Buffer.concat([header, question, ...records]);
}

function isDimInternal(qname: string): boolean { return qname === DIM_INTERNAL_SUFFIX.slice(1) || qname.endsWith(DIM_INTERNAL_SUFFIX); }

export interface NameResolverConfig {
  readonly listen: string; readonly port?: number; readonly gateway: string;
  readonly names: () => ReadonlySet<string>; readonly upstreams: () => readonly string[];
  readonly forwardTimeoutMs?: number; readonly maxInflightForwards?: number;
}
export interface NameResolverHandle { readonly udpPort: number; readonly tcpPort: number; readonly close: () => void; readonly closed: Promise<void> }

/** Bound host-side resolver for one workspace: answers registered *.dim.internal, forwards everything else once. */
export async function createNameResolver(config: NameResolverConfig): Promise<NameResolverHandle> {
  const forwardTimeout = config.forwardTimeoutMs ?? 2_000, maxInflight = config.maxInflightForwards ?? 64;
  let inflight = 0;

  function ownAnswer(parsed: ParsedDnsQuery, query: Buffer): Buffer | undefined {
    if (!isDimInternal(parsed.qname)) return undefined;
    if (!config.names().has(parsed.qname)) return encodeDnsResponse(query, parsed, 3, []); // NXDOMAIN
    if (parsed.qtype === 1) return encodeDnsResponse(query, parsed, 0, [{ ttl: 30, address: config.gateway }]);
    return encodeDnsResponse(query, parsed, 0, []); // name exists, no record of this type
  }

  async function forward(query: Buffer): Promise<Buffer | undefined> {
    const upstreams = config.upstreams();
    if (upstreams.length === 0 || inflight >= maxInflight) return undefined;
    // IPv6 upstreams carry their own colons; only a single-colon suffix of digits is a port override.
    const withPort = /^([^:]+):(\d+)$/.exec(upstreams[0]!);
    const host = withPort ? withPort[1]! : upstreams[0]!, upstreamPort = withPort ? Number(withPort[2]) : 53;
    if (!host || upstreamPort < 1 || upstreamPort > 65535) return undefined;
    inflight++;
    try {
      const socket = dgram.createSocket("udp4");
      let settled = false;
      const finish = () => { if (!settled) { settled = true; try { socket.close(); } catch { /* already closed */ } } };
      return await new Promise<Buffer | undefined>((resolve) => {
        const timer = setTimeout(() => { finish(); resolve(undefined); }, forwardTimeout);
        socket.once("message", (message) => { clearTimeout(timer); finish(); resolve(message); });
        socket.once("error", () => { clearTimeout(timer); finish(); resolve(undefined); });
        socket.send(query, upstreamPort, host, (error) => { if (error) { clearTimeout(timer); finish(); resolve(undefined); } });
      });
    } finally { inflight--; }
  }

  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, remote) => {
    const parsed = parseDnsQuery(message);
    if (!parsed) return; // malformed: dropped, never forwarded or answered
    void (async () => {
      const answer = ownAnswer(parsed, message) ?? await forward(message);
      if (answer) { try { udp.send(answer, remote.port, remote.address); } catch { /* client gone */ } }
    })();
  });
  udp.on("error", () => { /* a single bad datagram must not take the resolver down */ });

  const sockets = new Set<Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(5_000, () => socket.destroy());
    let buffer = Buffer.alloc(0), handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const length = buffer.readUInt16BE(0);
      if (length > MAX_MESSAGE) { socket.destroy(); return; }
      if (buffer.length < 2 + length) return;
      handled = true;
      const query = buffer.subarray(2, 2 + length);
      const parsed = parseDnsQuery(query);
      if (!parsed) { socket.destroy(); return; }
      void (async () => {
        const answer = ownAnswer(parsed, query) ?? await forward(query);
        if (!answer) { socket.destroy(); return; }
        const framed = Buffer.alloc(2 + answer.length);
        framed.writeUInt16BE(answer.length, 0); answer.copy(framed, 2);
        socket.end(framed);
      })();
    });
    socket.on("error", () => { /* best-effort; the client lost the connection */ });
  });
  tcp.maxConnections = 64;

  await Promise.all([
    new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(config.port ?? 53, config.listen, resolve); }),
    new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(config.port ?? 53, config.listen, resolve); })
  ]);
  const udpAddress = udp.address(), tcpAddress = tcp.address();
  if (typeof tcpAddress !== "object" || tcpAddress === null) throw new Error("name resolver TCP listener unavailable");

  let closing = false, didClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => { didClose = resolve; });
  function close(): void {
    if (closing) return; closing = true;
    for (const socket of sockets) socket.destroy();
    udp.close();
    tcp.close(() => didClose());
  }
  return { udpPort: udpAddress.port, tcpPort: tcpAddress.port, close, closed };
}
