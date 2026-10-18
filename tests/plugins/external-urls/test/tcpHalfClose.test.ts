import { createHash } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { afterEach, expect, it } from "vitest";
import { TcpIngressListener } from "../../../../plugin-external-urls/src/tcpIngress.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("preserves a delayed binary response after the client finishes sending", async () => {
  const input = Buffer.alloc(512 * 1024 + 1); for (let i = 0; i < input.length; i++) input[i] = i % 256;
  const upstream = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = []; socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => { setTimeout(() => socket.end(Buffer.concat(chunks)), 20); });
    socket.on("error", () => {});
  });
  const port = await ingress(upstream);
  const client = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  const chunks: Buffer[] = []; client.on("data", (chunk) => chunks.push(chunk));
  client.setTimeout(3000, () => client.destroy(new Error("half-close response timed out")));
  const done = once(client, "end"); client.end(input); await done; client.destroy();
  const response = Buffer.concat(chunks);
  expect(response.length).toBe(input.length);
  expect(createHash("sha256").update(response).digest("hex")).toBe(createHash("sha256").update(input).digest("hex"));
});

it("lets a client send after the upstream finishes its response direction", async () => {
  let received!: (bytes: Buffer) => void;
  const upload = new Promise<Buffer>((resolve) => { received = resolve; });
  const upstream = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = []; socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => received(Buffer.concat(chunks)));
    socket.on("error", () => {}); socket.end("ready");
  });
  const port = await ingress(upstream);
  const client = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  client.setTimeout(3000, () => client.destroy(new Error("half-close upload timed out")));
  const chunks: Buffer[] = []; client.on("data", (chunk) => chunks.push(chunk));
  await once(client, "end"); expect(Buffer.concat(chunks).toString()).toBe("ready");
  client.end("upload after response EOF");
  expect((await upload).toString()).toBe("upload after response EOF"); client.destroy();
});

async function ingress(upstream: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  upstream.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const upstreamAddress = upstream.address(); if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("missing upstream address");
  const reservation = net.createServer(); await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); if (!address || typeof address === "string") throw new Error("missing ingress address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const listener = new TcpIngressListener({ name: "halfclose", listenHost: "127.0.0.1", listenPort: address.port, publicHost: "127.0.0.1" });
  cleanups.push(() => listener.close());
  await listener.provision({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "development" },
    { target: { containers: [], port: upstreamAddress.port, protocol: "tcp" } },
    { host: "127.0.0.1", port: upstreamAddress.port, protocol: "tcp", fingerprint: "local-target" });
  return address.port;
}
