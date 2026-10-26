import { createServer, type IncomingHttpHeaders } from "node:http2";
import { request } from "node:http";
import { Duplex, PassThrough, Writable } from "node:stream";
import type { RunOptions } from "../types.js";
import { UserError } from "../errors.js";
import { workspaceServiceCleanup, workspaceServiceGuest, workspaceServiceMarker } from "./serviceChannelGuest.js";

interface WorkspaceServiceChannelOptions {
  readonly exec: (command: string[], options: RunOptions) => Promise<number>;
  readonly current: () => Promise<boolean>;
  readonly resolve: (service: string) => Promise<string | undefined>;
  readonly token: string;
  readonly port: number;
  readonly signal: AbortSignal;
}
const blocked = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "trailer"]);
function headers(input: IncomingHttpHeaders): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!name.startsWith(":") && !blocked.has(name) && value !== undefined) result[name] = typeof value === "number" ? String(value) : value;
  }
  return result;
}

export function openWorkspaceServiceChannel(options: WorkspaceServiceChannelOptions): {
  readonly ready: Promise<number>; readonly closed: Promise<void>; close(): Promise<void>;
} {
  const controller = new AbortController();
  const toGuest = new PassThrough(), fromGuest = new PassThrough();
  const wire = Duplex.from({ readable: fromGuest, writable: toGuest });
  const server = createServer({ maxHeaderListPairs: 64, settings: { maxConcurrentStreams: 128, maxHeaderListSize: 16384 } });
  const sessions = new Set<import("node:http2").ServerHttp2Session>();
  let resolveReady: (port: number) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => { rejectReady(new UserError("workspace internal service channel did not become ready")); controller.abort(); }, 10_000);
  void ready.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  server.on("session", (session) => { sessions.add(session); session.on("error", () => session.destroy()); session.once("close", () => sessions.delete(session)); });
  server.on("error", () => controller.abort());
  wire.on("error", () => controller.abort());
  server.on("stream", (stream, incoming) => {
    stream.on("error", () => { if (!stream.destroyed) stream.destroy(); });
    const deny = (status: number) => { if (!stream.destroyed) { stream.respond({ ":status": status }); stream.end(); } };
    void (async () => {
      if (!(await options.current())) { deny(410); return; }
      if (incoming[":path"] === "/_ready" && incoming[":method"] === "GET") {
        const port = Number(incoming["x-dim-guest-port"]);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || options.port !== 0 && port !== options.port) { deny(400); return; }
        deny(204); resolveReady(port); return;
      }
      const path = incoming[":path"];
      const match = typeof path === "string" ? /^\/services\/([a-z][a-z0-9-]{0,63})(\/[^\r\n]*)$/.exec(path) : null;
      if (!match?.[1] || !match[2] || incoming[":method"] === "CONNECT" || incoming.origin !== undefined) { deny(403); return; }
      const endpoint = await options.resolve(match[1]);
      if (!endpoint) { deny(404); return; }
      const target = new URL(endpoint);
      if (target.protocol !== "http:" || target.username || target.password || target.origin !== endpoint) throw new UserError("invalid host-owned workspace service target");
      if (stream.destroyed || !(await options.current())) { deny(410); return; }
      const upstream = request(target, { method: incoming[":method"], path: match[2], headers: headers(incoming), signal: controller.signal }, (response) => {
        if (stream.destroyed) { response.destroy(); return; }
        stream.respond({ ...headers(response.headers), ":status": response.statusCode ?? 502 });
        response.on("error", () => stream.destroy(new UserError("workspace upstream stream aborted")));
        response.pipe(stream);
      });
      upstream.on("error", () => { if (!stream.headersSent) deny(503); else stream.destroy(new UserError("workspace upstream stream failed")); });
      stream.once("close", () => upstream.destroy());
      stream.pipe(upstream);
    })().catch(() => { if (!stream.headersSent) deny(503); else stream.destroy(new UserError("workspace service stream failed")); });
  });
  server.emit("connection", wire);
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) controller.abort();
  controller.signal.addEventListener("abort", () => { for (const session of sessions) session.destroy(); wire.destroy(); toGuest.destroy(); fromGuest.destroy(); }, { once: true });
  const closed = (async () => {
    try {
      await options.exec(["node", "--input-type=commonjs", "-e", workspaceServiceGuest, String(options.port), workspaceServiceMarker, options.token], {
        stdin: toGuest, stdout: fromGuest, stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }), signal: controller.signal,
      });
    } finally {
      rejectReady(new UserError("workspace internal service channel disconnected"));
      controller.abort(); options.signal.removeEventListener("abort", abort);
      const code = await options.exec(["node", "--input-type=commonjs", "-e", workspaceServiceCleanup, options.token], {
        signal: AbortSignal.timeout(3000), stdout: new Writable({ write(_chunk, _encoding, done) { done(); } }),
        stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
      });
      if (code !== 0) throw new UserError(`owned workspace service channel cleanup could not be confirmed (exit ${code})`);
    }
  })();
  void closed.catch((error: unknown) => rejectReady(error instanceof Error ? error : new UserError("workspace service channel failed")));
  return { ready, closed, async close() { controller.abort(); await closed; } };
}
