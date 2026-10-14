import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import {
  ensureRelay, initialPhase, phasePath, prepareStateDirectory, publishOwner, RelayError,
  setRelayPhase, stopRelay, writePhase
} from "./agent-git-relay-supervisor.mjs";

const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const scriptPath = new URL(import.meta.url).pathname;
const command = process.argv[2] ?? "serve";
if (command === "ensure") await ensureRelay(relayConfig(), scriptPath);
else if (command === "serve") await serve();
else if (command === "phase") await setRelayPhase(process.argv[3], scriptPath);
else if (command === "stop") await stopRelay(scriptPath);
else throw new RelayError("unknown agent Git relay command");

async function serve() {
  const config = relayConfig();
  const ownerId = process.env.DIM_AGENT_GIT_OWNER_ID ?? randomBytes(32).toString("base64url");
  const configHash = process.env.DIM_AGENT_GIT_CONFIG_HASH ?? config.hash;
  if (configHash !== config.hash) throw new RelayError("agent Git relay configuration attestation mismatch");
  await prepareStateDirectory();
  try { await readFile(phasePath, "utf8"); } catch { await writePhase(initialPhase()); }
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: REQUEST_TIMEOUT_MS },
    (request, response) => void relay(config, ownerId, request, response));
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  process.send?.(await publishOwner({ ownerId, configHash, host: config.host, port: config.port }, scriptPath));
  process.disconnect?.();
}

async function relay(config, ownerId, request, response) {
  if (request.url === "/.dim/health") {
    request.resume();
    response.writeHead(request.headers["x-dim-relay-owner"] === ownerId ? 200 : 404).end();
    return;
  }
  const rawTarget = request.url ?? "";
  if (!rawTarget.startsWith("/") || rawTarget.startsWith("//") || rawTarget.includes("#")) {
    request.resume();
    response.writeHead(400).end();
    return;
  }
  const route = gitRoute(config.path, request);
  if (!route) {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  const phase = (await readFile(phasePath, "utf8")).trim();
  if (!(phase === "ready" || (phase === "setting-up" && route.operation === "read"))) {
    request.resume();
    response.writeHead(409).end();
    return;
  }
  const length = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) {
    request.resume();
    response.writeHead(413).end();
    return;
  }
  const target = new URL(config.origin.origin);
  target.pathname = route.pathname;
  target.search = route.search;
  const headers = { host: target.host };
  for (const name of ["accept", "content-type", "git-protocol", "user-agent"]) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (length > 0) headers["content-length"] = String(length);
  const send = target.protocol === "https:" ? https.request : http.request;
  const upstream = send(target, { method: request.method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        incoming.destroy();
        response.writeHead(502).end();
        return;
      }
      const responseHeaders = {};
      for (const name of ["cache-control", "content-length", "content-type", "etag"]) {
        const value = incoming.headers[name];
        if (value !== undefined) responseHeaders[name] = value;
      }
      response.writeHead(status, responseHeaders);
      incoming.pipe(response);
    });
  let received = 0;
  request.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_REQUEST_BYTES) {
      upstream.destroy();
      if (!response.headersSent) response.writeHead(413);
      response.end();
    }
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

function relayConfig() {
  const mode = process.env.DIM_AGENT_GIT_RELAY_MODE;
  const upstream = process.env.DIM_AGENT_GIT_UPSTREAM;
  const path = process.env.DIM_AGENT_GIT_PATH;
  const host = process.env.DIM_AGENT_GIT_LISTEN_HOST;
  const port = Number(process.env.DIM_AGENT_GIT_LISTEN_PORT ?? "19419");
  if (mode !== "native" || !upstream || !path || !host || !path.startsWith("/")
    || path.endsWith("/") || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RelayError("invalid agent Git relay configuration");
  }
  const origin = new URL(upstream);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.username || origin.password
    || origin.search || origin.hash) throw new RelayError("invalid agent Git relay upstream");
  const hash = createHash("sha256").update(JSON.stringify({ mode, origin: origin.origin, path, host, port }))
    .digest("hex");
  return { origin, path, host, port, hash };
}

function gitRoute(allowedPath, request) {
  const url = new URL(request.url ?? "", "http://relay.invalid");
  if (!url.pathname.startsWith(`${allowedPath}/`)) return undefined;
  const endpoint = url.pathname.slice(allowedPath.length);
  if (request.method === "GET" && endpoint === "/info/refs" && url.searchParams.size === 1) {
    const service = url.searchParams.get("service");
    if (service === "git-upload-pack" || service === "git-receive-pack") {
      return { pathname: url.pathname, search: url.search, operation: service === "git-upload-pack" ? "read" : "write" };
    }
  }
  if (request.method === "POST" && url.search === "" && endpoint === "/git-upload-pack"
    && request.headers["content-type"] === "application/x-git-upload-pack-request") {
    return { pathname: url.pathname, search: "", operation: "read" };
  }
  if (request.method === "POST" && url.search === "" && endpoint === "/git-receive-pack"
    && request.headers["content-type"] === "application/x-git-receive-pack-request") {
    return { pathname: url.pathname, search: "", operation: "write" };
  }
  return undefined;
}
