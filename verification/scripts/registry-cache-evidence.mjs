import { createHash } from "node:crypto";
import { open, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIPv4 } from "node:net";
import { once } from "node:events";

const MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
const CONFIG_MEDIA_TYPE = "application/vnd.docker.container.image.v1+json";
const API_VERSION_HEADER = { "docker-distribution-api-version": "registry/2.0" };

const options = parseOptions(process.argv.slice(2));
const runId = sanitize(options.runId, "run ID");
const route = sanitize(options.route, "route");
const repository = `dim-cache-evidence/${runId}/${route}`;
const config = Buffer.from(JSON.stringify({
  architecture: "amd64",
  config: { Labels: {
    "org.dev-infra-manager.cache-route": route,
    "org.dev-infra-manager.run": runId
  } },
  os: "linux",
  rootfs: { type: "layers", diff_ids: [] }
}));
const configDigest = digest(config);
const manifest = Buffer.from(JSON.stringify({
  schemaVersion: 2,
  mediaType: MANIFEST_MEDIA_TYPE,
  config: { mediaType: CONFIG_MEDIA_TYPE, size: config.length, digest: configDigest },
  layers: []
}));
const manifestDigest = digest(manifest);
const evidence = await open(options.evidenceFile, "w");
let sequence = 0;
let evidenceWrites = Promise.resolve();
let stopping = false;

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    response.destroy(error instanceof Error ? error : undefined);
    process.exitCode = 1;
    void shutdown();
  });
});

server.listen(options.port, options.bindAddress);
await once(server, "listening");
const address = server.address();
if (address === null || typeof address === "string") throw new TypeError("registry fixture has no TCP address");
const baseUrl = `http://${options.bindAddress}:${address.port}`;
const readiness = {
  schema_version: 1,
  event_kind: "registry-cache-fixture-ready",
  run_id: runId,
  route,
  repository,
  manifest_digest: manifestDigest,
  config_digest: configDigest,
  host: options.bindAddress,
  port: address.port,
  base_url: baseUrl,
  evidence_file: options.evidenceFile
};
if (options.readyFile) {
  const temporaryReadyFile = `${options.readyFile}.tmp-${process.pid}`;
  await writeFile(temporaryReadyFile, `${JSON.stringify(readiness)}\n`);
  await rename(temporaryReadyFile, options.readyFile);
}
process.stdout.write(`${JSON.stringify(readiness)}\n`);

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleRequest(request, response) {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", baseUrl).pathname;
  if (pathname === "/v2/" && (method === "GET" || method === "HEAD")) {
    await record({ method, result: "api-version" });
    return reply(request, response, 200, Buffer.alloc(0), "application/json");
  }
  if (pathname.includes("/blobs/uploads") || (method !== "GET" && method !== "HEAD")) {
    const fields = routeFields(pathname);
    await record({ method, ...fields, result: "method-not-allowed" });
    return registryError(request, response, 405, "UNSUPPORTED", "operation is not supported", fields, {
      allow: "GET, HEAD"
    });
  }

  const manifestMatch = pathname.match(/^\/v2\/(.+)\/manifests\/([^/]+)$/);
  if (manifestMatch) {
    const [, requestedRepository, reference] = manifestMatch;
    const found = requestedRepository === repository && (reference === "probe" || reference === manifestDigest);
    await record({ method, repository: requestedRepository, reference, result: found ? "manifest" : "manifest-unknown" });
    if (found) return artifact(request, response, manifest, MANIFEST_MEDIA_TYPE, manifestDigest);
    return registryError(request, response, 404, "MANIFEST_UNKNOWN", "manifest unknown", {
      repository: requestedRepository,
      reference
    });
  }

  const blobMatch = pathname.match(/^\/v2\/(.+)\/blobs\/([^/]+)$/);
  if (blobMatch) {
    const [, requestedRepository, requestedDigest] = blobMatch;
    const found = requestedRepository === repository && requestedDigest === configDigest;
    await record({ method, repository: requestedRepository, digest: requestedDigest, result: found ? "blob" : "blob-unknown" });
    if (found) return artifact(request, response, config, CONFIG_MEDIA_TYPE, configDigest);
    return registryError(request, response, 404, "BLOB_UNKNOWN", "blob unknown to registry", {
      repository: requestedRepository,
      digest: requestedDigest
    });
  }

  await record({ method, result: "unsupported" });
  return registryError(request, response, 404, "UNSUPPORTED", "endpoint is not supported", {});
}

function record(fields) {
  const line = `${JSON.stringify({
    run_id: runId,
    sequence: ++sequence,
    route,
    event_kind: "upstream-request",
    ...fields
  })}\n`;
  evidenceWrites = evidenceWrites.then(() => evidence.appendFile(line));
  return evidenceWrites;
}

function artifact(request, response, body, contentType, contentDigest) {
  return reply(request, response, 200, body, contentType, { "docker-content-digest": contentDigest });
}

function registryError(request, response, status, code, message, detail, headers = {}) {
  const body = Buffer.from(JSON.stringify({ errors: [{ code, message, detail }] }));
  return reply(request, response, status, body, "application/json", headers);
}

function reply(request, response, status, body, contentType, headers = {}) {
  response.writeHead(status, {
    ...API_VERSION_HEADER,
    "content-type": contentType,
    "content-length": String(body.length),
    ...headers
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function routeFields(pathname) {
  const match = pathname.match(/^\/v2\/(.+?)\/(?:manifests|blobs)(?:\/|$)/);
  return match ? { repository: match[1] } : {};
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sanitize(value, name) {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (sanitized.length === 0) throw new TypeError(`${name} must contain an ASCII letter or number`);
  return sanitized;
}

function parseOptions(arguments_) {
  if (arguments_.includes("--help")) {
    process.stdout.write("usage: registry-cache-evidence.mjs --run-id ID --route ROUTE --evidence-file PATH [--bind-address IPV4] [--port PORT] [--ready-file PATH]\n");
    process.exit(0);
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new TypeError("fixture arguments must be --name value pairs");
    values.set(key, value);
  }
  const runIdValue = values.get("--run-id");
  const routeValue = values.get("--route");
  const evidenceFile = values.get("--evidence-file");
  const bindAddress = values.get("--bind-address") ?? "127.0.0.1";
  const readyFile = values.get("--ready-file");
  const port = Number.parseInt(values.get("--port") ?? "0", 10);
  if (!runIdValue || !routeValue || !evidenceFile) throw new TypeError("--run-id, --route, and --evidence-file are required");
  if (!isIPv4(bindAddress) || bindAddress === "0.0.0.0") {
    throw new TypeError("--bind-address must be an IPv4 address other than 0.0.0.0");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("--port must be between 0 and 65535");
  return { runId: runIdValue, route: routeValue, evidenceFile, bindAddress, port, readyFile };
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await once(server, "close");
  await evidenceWrites;
  await evidence.sync();
  await evidence.close();
  process.exit();
}
