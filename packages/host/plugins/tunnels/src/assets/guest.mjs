#!/usr/bin/env node
// @ts-check
import { createServer, connect } from "node:net";
import { createSocket } from "node:dgram";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** @typedef {{name:string,protocol:'tcp'|'udp',localPort:number,token:string}} GuestTunnel */
/** @typedef {{schemaVersion:1,endpoint:string,tunnels:GuestTunnel[]}} GuestConfiguration */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {GuestConfiguration} */
export function parseGuestConfiguration(value) {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.endpoint !== "string" || !Array.isArray(value.tunnels)) throw new Error("invalid tunnel configuration");
  const endpoint = new URL(`tcp://${value.endpoint}`);
  if (!endpoint.hostname || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname || endpoint.search || endpoint.hash) throw new Error("endpoint must be HOST:PORT");
  /** @type {GuestTunnel[]} */ const tunnels = [];
  const names = new Set(), ports = new Set();
  for (const tunnel of value.tunnels) {
    if (!object(tunnel) || typeof tunnel.name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(tunnel.name)
      || (tunnel.protocol !== "tcp" && tunnel.protocol !== "udp") || typeof tunnel.localPort !== "number"
      || !Number.isInteger(tunnel.localPort) || tunnel.localPort < 1 || tunnel.localPort > 65535
      || typeof tunnel.token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(tunnel.token)
      || names.has(tunnel.name) || ports.has(`${tunnel.protocol}:${tunnel.localPort}`)) throw new Error("invalid or duplicate guest tunnel");
    names.add(tunnel.name); ports.add(`${tunnel.protocol}:${tunnel.localPort}`);
    tunnels.push({ name: tunnel.name, protocol: tunnel.protocol, localPort: tunnel.localPort, token: tunnel.token });
  }
  return { schemaVersion: 1, endpoint: value.endpoint, tunnels };
}
/** @param {GuestConfiguration} configuration */
export async function startGuest(configuration) {
  const endpoint = new URL(`tcp://${configuration.endpoint}`), port = Number(endpoint.port);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  /** @type {Set<() => void>} */ const cleanup = new Set();
  /** @type {Set<import('node:net').Socket>} */ const sockets = new Set();
  try {
    for (const tunnel of configuration.tunnels) {
      const header = Buffer.from(`${JSON.stringify({ token: tunnel.token })}\n`);
      if (tunnel.protocol === "tcp") {
        const server = createServer({ allowHalfOpen: true }, (local) => {
          local.pause(); sockets.add(local); const remote = connect({ host, port, allowHalfOpen: true }); sockets.add(remote);
          const close = () => { local.destroy(); remote.destroy(); sockets.delete(local); sockets.delete(remote); };
          local.on("error", close); remote.on("error", close); local.once("close", close); remote.once("close", close);
          remote.setTimeout(10_000, close);
          remote.once("connect", () => remote.write(header));
          let reply = Buffer.alloc(0), acknowledged = false;
          remote.once("end", () => { if (!acknowledged) close(); });
          /** @param {Buffer} chunk */
          const ready = (chunk) => {
            reply = Buffer.concat([reply, chunk]); const end = reply.indexOf(10);
            if (end < 0) { if (reply.length > 64) close(); return; }
            remote.off("data", ready);
            if (reply.subarray(0, end).toString() !== "OK") { close(); return; }
            acknowledged = true; remote.setTimeout(0); const rest = reply.subarray(end + 1); if (rest.length) local.write(rest);
            local.pipe(remote); remote.pipe(local); local.resume(); if (local.readableEnded) remote.end();
          };
          remote.on("data", ready);
        });
        cleanup.add(() => { server.close(); });
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(tunnel.localPort, "127.0.0.1", () => resolve(undefined)); });
      } else {
        const local = createSocket("udp4");
        /** @type {Map<string,{socket:import('node:dgram').Socket,touched:number,connected:boolean,queue:Buffer[]}>} */ const peers = new Map();
        local.on("error", () => {});
        local.on("message", (data, peer) => {
          if (data.length + header.length > 65_507) return;
          const key = `${peer.address}:${peer.port}`; let entry = peers.get(key);
          if (!entry) {
            if (peers.size >= 256) return;
            const socket = createSocket("udp4"); entry = { socket, touched: Date.now(), connected: false, queue: [data] }; peers.set(key, entry);
            socket.on("error", () => { try { socket.close(); } catch { /* Closed during shutdown. */ } peers.delete(key); });
            socket.on("message", (message) => local.send(message, peer.port, peer.address, () => {}));
            const created = entry;
            socket.connect(port, host, () => { created.connected = true; for (const packet of created.queue) socket.send(Buffer.concat([header, packet]), () => {}); created.queue = []; });
          } else if (entry.connected) entry.socket.send(Buffer.concat([header, data]), () => {});
          else if (entry.queue.length < 8) entry.queue.push(data);
          entry.touched = Date.now();
        });
        const timer = setInterval(() => { for (const [key, entry] of peers) if (Date.now() - entry.touched > 30_000) { entry.socket.close(); peers.delete(key); } }, 5000);
        cleanup.add(() => { clearInterval(timer); for (const entry of peers.values()) entry.socket.close(); try { local.close(); } catch { /* Bind failed. */ } });
        await new Promise((resolve, reject) => { local.once("error", reject); local.bind(tunnel.localPort, "127.0.0.1", () => resolve(undefined)); });
      }
    }
  } catch (error) { for (const socket of sockets) socket.destroy(); for (const close of cleanup) close(); throw error; }
  return { close() { for (const socket of sockets) socket.destroy(); for (const close of cleanup) close(); cleanup.clear(); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || process.argv.length !== 3) throw new Error("usage: dim-tunnel-guest PRIVATE_CONFIG");
    const handle = await open(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW);
    let value;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024) throw new Error("tunnel configuration must be private and user owned");
      value = parseGuestConfiguration(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
    const server = await startGuest(value);
    process.once("SIGTERM", () => server.close()); process.once("SIGINT", () => server.close());
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
