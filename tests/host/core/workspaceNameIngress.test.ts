import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createNameIngress, type NameIngressHandle } from "@slop-lab/dim-host-core/workspace";

const handles: NameIngressHandle[] = [];
afterEach(async () => { for (const handle of handles.splice(0)) { handle.close(); await handle.closed; } });

function get(port: number, path: string, host: string): Promise<{ status: number; headers: IncomingMessage["headers"]; firstChunk: Promise<Buffer>; body(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      // Attach "data"/"end" immediately: a fast response can finish before the caller gets around to awaiting these.
      let resolveFirst: (chunk: Buffer) => void;
      const firstChunk = new Promise<Buffer>((resolveChunk) => { resolveFirst = resolveChunk; });
      const ended = new Promise<string>((resolveBody) => response.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8"))));
      response.on("data", (chunk: Buffer) => { if (chunks.length === 0) resolveFirst(chunk); chunks.push(chunk); });
      resolve({ status: response.statusCode ?? 0, headers: response.headers, firstChunk, body: () => ended });
    });
    request.on("error", reject); request.end();
  });
}

async function upstreamServer(handler: (path: string | undefined) => { status: number; body: string }) {
  const server = createServer((request, response) => {
    const { status, body } = handler(request.url);
    response.writeHead(status, { "content-type": "text/plain" }); response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("upstream unavailable");
  return { port: address.port, close: () => server.close() };
}

async function streamingUpstream(delayMs: number) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("first-chunk-");
    setTimeout(() => { response.end("second-chunk"); }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("upstream unavailable");
  return { port: address.port, close: () => server.close() };
}

async function ingress(upstreams: ReadonlyMap<string, string>) {
  const handle = await createNameIngress({ listen: "127.0.0.1", port: 0, upstreams: () => upstreams });
  handles.push(handle);
  return handle;
}

it("routes a known Host header to its registered upstream, forwarding method and path", async () => {
  const upstream = await upstreamServer((path) => ({ status: 200, body: `got:${path}` }));
  try {
    const handle = await ingress(new Map([["npm.cache.dim.internal", `http://127.0.0.1:${upstream.port}/`]]));
    const response = await get(handle.port, "/some/path?x=1", "npm.cache.dim.internal");
    expect(response.status).toBe(200);
    expect(await response.body()).toBe("got:/some/path?x=1");
  } finally { upstream.close(); }
});

it("returns 404 for an unknown Host header without contacting any upstream", async () => {
  const handle = await ingress(new Map([["npm.cache.dim.internal", "http://127.0.0.1:1/"]]));
  const response = await get(handle.port, "/", "unregistered.dim.internal");
  expect(response.status).toBe(404);
});

it("ignores the port suffix on the Host header when matching", async () => {
  const upstream = await upstreamServer(() => ({ status: 200, body: "ok" }));
  try {
    const handle = await ingress(new Map([["npm.cache.dim.internal", `http://127.0.0.1:${upstream.port}/`]]));
    const response = await get(handle.port, "/", "npm.cache.dim.internal:1234");
    expect(response.status).toBe(200);
  } finally { upstream.close(); }
});

it("streams the upstream response rather than buffering it whole", async () => {
  const delayMs = 1_000;
  const upstream = await streamingUpstream(delayMs);
  try {
    const handle = await ingress(new Map([["npm.cache.dim.internal", `http://127.0.0.1:${upstream.port}/`]]));
    const startedAt = Date.now();
    const response = await get(handle.port, "/", "npm.cache.dim.internal");
    const first = await response.firstChunk;
    // A buffering proxy could only deliver the first chunk after the upstream's full (delayed) response.
    expect(Date.now() - startedAt).toBeLessThan(delayMs / 2);
    expect(first.toString("utf8")).toBe("first-chunk-");
    expect(await response.body()).toBe("first-chunk-second-chunk");
  } finally { upstream.close(); }
});
