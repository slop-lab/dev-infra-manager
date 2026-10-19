#!/usr/bin/env -S tsx
/** Disposable public-package cache verification. No installed cache or workspace is changed. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner } from "../../packages/host/core/src/runner.js";
import { ensureCacheServices, cacheServiceNames } from "../../packages/host/plugins/cache-server/src/cache-services.js";
import { MirrorState } from "../../packages/host/plugins/cache-server/src/cacheState.js";
import { npmCacheDefinition, pypiCacheDefinition } from "../../packages/host/plugins/cache-server/src/packageCaches.js";

const [npmImage, pypiImage] = process.argv.slice(2);
if (!npmImage || !pypiImage || [npmImage, pypiImage].some((image) => !/^\S+@sha256:[a-f0-9]{64}$/.test(image))) {
  throw new Error("usage: tsx package-cache-smoke.mts NPM_IMAGE@sha256:DIGEST PYPI_IMAGE@sha256:DIGEST");
}
const token = randomUUID().slice(0, 8), namespace = `dim-packages-${token}`;
const directory = await mkdtemp(join(tmpdir(), namespace)), front = `${namespace}-front`;
const runner = new ProcessRunner(), relays: Server[] = [];
let frontCreated = false;
async function docker(args: string[], allowedFailure = false) {
  const result = await runner.run("docker", args, { signal: AbortSignal.timeout(60_000) });
  if (!allowedFailure) assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
  return result;
}
async function proxy(host: string, port: number, kind: "npm" | "pypi"): Promise<string> {
  let origin = "";
  const server = createServer((incoming, outgoing) => {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") { outgoing.writeHead(405).end(); return; }
    const target = request({ hostname: host, port, method: incoming.method, path: incoming.url,
      headers: { host: new URL(origin).host, "x-forwarded-proto": "http", ...(kind === "pypi" ? { "x-outside-url": origin } : {}),
        ...(incoming.headers.accept ? { accept: incoming.headers.accept } : {}) }, timeout: 20_000
    }, (response) => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
    target.on("timeout", () => target.destroy(new Error("cache response timeout")));
    target.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => target.destroy()); target.end();
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`; relays.push(server); return origin;
}
async function response(url: string, accept = "application/json", timeout = 30_000) {
  return fetch(url, { headers: { accept }, redirect: "manual", signal: AbortSignal.timeout(timeout) });
}
async function ready(url: string, accept: string) {
  let diagnostic = "";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const result = await response(url, accept, Math.min(5000, deadline - Date.now())); if (result.ok) return; diagnostic = `HTTP ${result.status}`; await result.body?.cancel(); }
    catch (error) { diagnostic = String(error); }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`cache did not become ready: ${diagnostic}`);
}
function object(value: unknown): Record<string, unknown> { assert(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
async function json(url: string, accept?: string): Promise<Record<string, unknown>> { const result = await response(url, accept); assert.equal(result.status, 200); return object(await result.json()); }
async function bytes(url: string) { const result = await response(url, "application/octet-stream"); assert.equal(result.status, 200); return Buffer.from(await result.arrayBuffer()); }
function sha256(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function npmAsset(manifest: Record<string, unknown>, origin: string) { const dist = object(manifest.dist); assert.equal(typeof dist.tarball, "string"); const url = new URL(String(dist.tarball)); assert.equal(url.origin, origin, "npm tarball must stay on the cache relay"); return url.href; }
function wheel(index: Record<string, unknown>, base: string, version: string) {
  assert(Array.isArray(index.files));
  const item = object(index.files.find((value: unknown) => object(value).filename === `six-${version}-py2.py3-none-any.whl`));
  assert.equal(typeof item.url, "string"); const url = new URL(String(item.url), base);
  assert.equal(url.origin, new URL(base).origin, "PyPI wheel must stay on the cache relay");
  return { url: url.href, sha256: object(item.hashes).sha256 };
}
try {
  const published = await ensureCacheServices(runner, { stateRoot: directory, namespace }, [npmCacheDefinition(npmImage), pypiCacheDefinition(pypiImage)]);
  assert(published.npm && published.pypi);
  await ready(`http://${published.npm.host}:${published.npm.port}/is-number/7.0.0`, "application/json");
  await ready(`http://${published.pypi.host}:${published.pypi.port}/root/pypi/+simple/six/`, "application/vnd.pypi.simple.v1+json");
  console.log("host-published npm/PyPI endpoints accept real package metadata requests: PASS");
  await docker(["network", "create", "--internal", "--label", `dim.package-cache-smoke=${token}`, front]); frontCreated = true;
  const endpoints: Record<string, string> = {};
  for (const [name, port] of [["npm", 4873], ["pypi", 3141]] as const) {
    const container = cacheServiceNames(name, namespace).container;
    await docker(["network", "connect", front, container]);
    const host = (await docker(["inspect", container, "--format", `{{(index .NetworkSettings.Networks "${front}").IPAddress}}`])).stdout.trim();
    endpoints[name] = await proxy(host, port, name);
  }
  const npm = endpoints.npm!, pypi = endpoints.pypi!;
  const npmMetadata = `${npm}/is-number/7.0.0`, pypiIndex = `${pypi}/root/pypi/+simple/six/`;
  const simpleJson = "application/vnd.pypi.simple.v1+json";
  await ready(npmMetadata, "application/json"); await ready(pypiIndex, simpleJson);
  const manifest = await json(npmMetadata), index = await json(pypiIndex, simpleJson);
  const tarballUrl = npmAsset(manifest, npm), cachedWheel = wheel(index, pypiIndex, "1.17.0"), uncachedWheel = wheel(index, pypiIndex, "1.16.0");
  const tarball = await bytes(tarballUrl), packageWheel = await bytes(cachedWheel.url);
  assert.equal(createHash("sha1").update(tarball).digest("hex"), object(manifest.dist).shasum);
  assert.equal(sha256(packageWheel), cachedWheel.sha256);
  console.log("actual public npm metadata/tarball and PyPI simple-index/wheel, local relay asset URLs and upstream digests: PASS");
  for (const name of ["npm", "pypi"]) await docker(["network", "disconnect", cacheServiceNames(name, namespace).network, cacheServiceNames(name, namespace).container]);
  const warmManifest = await json(npmMetadata), warmIndex = await json(pypiIndex, simpleJson);
  assert.equal(sha256(await bytes(npmAsset(warmManifest, npm))), sha256(tarball));
  assert.equal(sha256(await bytes(wheel(warmIndex, pypiIndex, "1.17.0").url)), sha256(packageWheel));
  console.log("fresh npm/PyPI metadata and exact cached package bytes with all cache egress networks detached: PASS");
  const missingNpm = await response(`${npm}/is-odd/3.0.1`), missingWheel = await response(uncachedWheel.url, "application/octet-stream");
  assert(!missingNpm.ok); assert(!missingWheel.ok); await missingNpm.body?.cancel(); await missingWheel.body?.cancel();
  console.log("uncached npm metadata and PyPI wheel fail offline without asset URL bypass: PASS");
} catch (error) {
  for (const name of ["npm", "pypi"]) {
    const logs = await docker(["logs", "--tail", "30", cacheServiceNames(name, namespace).container], true);
    process.stderr.write(`${name} diagnostics:\n${(logs.stdout + logs.stderr).slice(-8192)}\n`);
  }
  throw error;
} finally {
  for (const server of relays) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  const ownership = await new MirrorState(directory, namespace).readHostMirrorOwnership();
  for (const name of ["npm", "pypi"]) {
    const names = cacheServiceNames(name, namespace);
    for (const [kind, resource, role] of [["container", names.container, `cache:${name}`], ["volume", names.volume, `data:${name}`]] as const) {
      const inspected = await docker([kind, "inspect", resource, "--format", kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}"], true);
      if (inspected.exitCode !== 0) { assert.match(inspected.stderr, /No such (?:container|object|volume)|no such volume/i); continue; }
      const labels = object(JSON.parse(inspected.stdout));
      assert(ownership && labels["dim.service-id"] === ownership.serviceId && labels["dim.resource"] === role && labels["dim.resource-id"] === ownership.resourceIds[role], `preserving foreign ${kind} ${resource}`);
      await docker([kind, "rm", ...(kind === "container" ? ["--force"] : []), resource]);
    }
  }
  if (frontCreated) {
    const labels = object(JSON.parse((await docker(["network", "inspect", front, "--format", "{{json .Labels}}"])).stdout));
    assert.equal(labels["dim.package-cache-smoke"], token, "preserving foreign frontend network");
    await docker(["network", "rm", front]);
  }
  const network = cacheServiceNames("npm", namespace).network;
  const inspected = await docker(["network", "inspect", network, "--format", "{{json .Labels}}"], true);
  if (inspected.exitCode === 0) {
    const labels = object(JSON.parse(inspected.stdout)); assert(ownership && labels["dim.service-id"] === ownership.serviceId && labels["dim.resource-id"] === ownership.resourceIds.network);
    await docker(["network", "rm", network]);
  } else assert.match(inspected.stderr, /network .* not found|No such (?:object|network)/i);
  await rm(directory, { recursive: true, force: true });
}
