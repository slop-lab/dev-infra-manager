#!/usr/bin/env -S tsx
/** Four-endpoint workspace attachment with disposable nested Docker/APT checks.
 * npm/PyPI artifact reuse is checked separately by package-cache-smoke.mts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner } from "../../core/packages/core/src/runner.js";
import { WorkspaceStore } from "../../core/packages/core/src/workspace/store.js";
import { WorkspaceService } from "../../core/packages/core/src/workspace/service.js";
import { ContainerWorkspaceRuntime } from "../../core/packages/core/src/workspace/runtime.js";
import { acquireWorkspaceSource } from "../../core/packages/core/src/workspace/source.js";
import type { WorkspaceHostPluginContext } from "../../core/packages/core/src/workspace/hostPlugin.js";
const image = process.argv[2]; if (!image) throw new Error("usage: tsx auto-host-mirrors-smoke.mts WORKSPACE_IMAGE");
const artifact: typeof import("../../plugin-host-mirrors/src/attachment.js") = await import(new URL("../../plugin-host-mirrors/dist/attachment.js", import.meta.url).href);
const packageCaches: typeof import("../../plugin-cache-server/src/packageCaches.js") = await import(new URL("../../plugin-cache-server/dist/packageCaches.js", import.meta.url).href);
const pins: unknown = JSON.parse(await readFile(new URL("../../plugin-cache-server/dist/cache-images.json", import.meta.url), "utf8"));
function pin(kind: string): string {
  assert(pins !== null && typeof pins === "object" && !Array.isArray(pins));
  const image: unknown = Reflect.get(pins, kind);
  assert(typeof image === "string" && /@sha256:[a-f0-9]{64}$/.test(image), `reviewed ${kind} image pin is required`);
  return image;
}
const token = randomUUID().slice(0, 8), prefix = `dim-mirrors-smoke-${token}`;
const root = await mkdtemp(join(tmpdir(), prefix));
const runner = new ProcessRunner(), runtime = new ContainerWorkspaceRuntime(runner), store = new WorkspaceStore(join(root, "workspaces"));
const service = new WorkspaceService(store, runtime, acquireWorkspaceSource);
const registry = `${prefix}-registry`, apt = `${prefix}-apt`, npm = `${prefix}-npm`, pypi = `${prefix}-pypi`, network = `${prefix}-network`, egress = `${prefix}-egress`, volumes = [`${prefix}-registry-data`, `${prefix}-apt-data`, `${prefix}-npm-data`, `${prefix}-pypi-data`];
let workspace: Awaited<ReturnType<typeof service.create>> | undefined;
async function run(args: string[], allowedFailure = false) {
  const result = await runner.run("docker", args, { signal: AbortSignal.timeout(180_000) });
  if (!allowedFailure) assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`); return result;
}
const registryImage = "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33";
const aptImage = "sameersbn/apt-cacher-ng@sha256:58e74113cfac7e593201444648c105351cbfce7538bfb36dcafdc9479b2aefcc";
async function address(name: string) { return (await run(["inspect", name, "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`])).stdout.trim(); }
async function startApt() { await run(["create", "--name", apt, "--network", network, "--mount", `type=volume,src=${volumes[1]},dst=/var/cache/apt-cacher-ng`, aptImage]); await run(["network", "connect", egress, apt]); await run(["start", apt]); }
async function startPackageCache(name: string, definition: import("../../plugin-cache-server/src/cache-services.js").CacheServiceDefinition, volume: string) {
  const configuration = join(root, name); await mkdir(configuration);
  const mounts: string[] = [];
  for (const file of definition.configFiles ?? []) {
    const source = join(configuration, file.name); await writeFile(source, file.contents, { mode: 0o644 });
    mounts.push("--mount", `type=bind,src=${source},dst=${file.target},readonly`);
  }
  const args = ["create", "--name", name, "--network", network, "--mount", `type=volume,src=${volume},dst=${definition.dataTarget}`,
    ...mounts, ...Object.entries(definition.environment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
  if (definition.entrypoint?.[0]) args.push("--entrypoint", definition.entrypoint[0]);
  args.push(definition.image, ...(definition.entrypoint?.slice(1) ?? []), ...(definition.command ?? []));
  await run(args); await run(["network", "connect", egress, name]); await run(["start", name]);
}
async function attach() {
  assert(workspace);
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: root, store, service, signal: AbortSignal.timeout(60_000), hostGateway: (record) => runtime.hostGateway(record) };
  await artifact.attachWorkspaceMirrors(workspace, context, { endpoints: {
    docker: `http://${await address(registry)}:5000/`, apt: `http://${await address(apt)}:3142/`,
    npm: `http://${await address(npm)}:4873/`, pypi: `http://${await address(pypi)}:3141/root/pypi/+simple/`
  } });
}
async function guest(args: string[], allowedFailure = false) {
  assert(workspace); const result = await runtime.run(workspace, args, { signal: AbortSignal.timeout(180_000) });
  if (!allowedFailure) assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`); return result;
}
try {
  const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "README"), "mirror smoke\n");
  for (const args of [["init", "--initial-branch=main"], ["add", "."], ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "source"]]) {
    const result = await runner.run("git", ["-C", source, ...args]); assert.equal(result.exitCode, 0, result.stderr);
  }
  await run(["network", "create", network]);
  const subnet = (await run(["network", "inspect", network, "--format", "{{(index .IPAM.Config 0).Subnet}}"])).stdout.trim();
  await run(["network", "rm", network]);
  await run(["network", "create", "--internal", "--subnet", subnet, network]);
  await run(["network", "create", egress]);
  for (const volume of volumes) await run(["volume", "create", volume]);
  await run(["create", "--name", registry, "--network", network, "--mount", `type=volume,src=${volumes[0]},dst=/var/lib/registry`, "--env", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io", "--env", "REGISTRY_LOG_LEVEL=warn", registryImage]);
  await run(["network", "connect", egress, registry]);
  await run(["start", registry]);
  await startApt();
  await startPackageCache(npm, packageCaches.npmCacheDefinition(pin("npm")), volumes[2]!);
  await startPackageCache(pypi, packageCaches.pypiCacheDefinition(pin("pypi")), volumes[3]!);
  workspace = await service.create({ name: prefix, source: { url: source }, image, resources: { cpuCount: "2", memory: "3g", pidsLimit: "2048" } });
  await attach();
  const daemon = JSON.parse((await guest(["docker", "info", "--format", "{{json .RegistryConfig}}"])).stdout) as { Mirrors: string[] };
  assert.equal(daemon.Mirrors.length, 1);
  for (const [name, base] of [["debian", "debian:bookworm-slim"], ["ubuntu", "ubuntu:24.04"]] as const) {
    await guest(["docker", "run", "--detach", "--name", `apt-${name}`, base, "sleep", "infinity"]);
    await guest(["docker", "exec", `apt-${name}`, "sh", "-ceu", "apt-get update >/tmp/update.log 2>&1 || { cat /tmp/update.log; exit 1; }; cd /tmp; apt-get download hello >/tmp/download.log 2>&1 || { cat /tmp/download.log; exit 1; }; sha256sum hello*.deb > /tmp/cold.sha; rm hello*.deb"]);
    const conf = await guest(["docker", "exec", `apt-${name}`, "cat", "/etc/apt/apt.conf.d/99dim-mirrors"]);
    assert.match(conf.stdout, /Acquire::http::Proxy "http:\/\//); assert.doesNotMatch(conf.stdout, /HTTP_PROXY/);
  }
  console.log("actual nested Debian + Ubuntu cold APT and Docker registry pulls: PASS");
  // Keep the cache frontend address, but remove all of this owned cache's
  // Internet access and existing upstream connections.
  await run(["network", "disconnect", egress, apt]);
  for (const name of ["debian", "ubuntu"]) {
    await guest(["docker", "exec", `apt-${name}`, "sh", "-ceu", "cd /tmp; apt-get download hello >/tmp/warm.log 2>&1 || { cat /tmp/warm.log; exit 1; }; sha256sum -c /tmp/cold.sha; rm hello*.deb"]);
  }
  console.log("actual nested Debian + Ubuntu warm .deb bytes with origin blocked: PASS");
  const oldApt = await address(apt);
  await run(["rm", "--force", apt]);
  // Occupy its old bridge address so replacement necessarily has a new IP.
  const holder = `${prefix}-address-holder`;
  await run(["run", "--detach", "--name", holder, "--network", network, "--ip", oldApt, "--entrypoint", "sleep", registryImage, "infinity"]);
  try { await startApt(); assert.notEqual(await address(apt), oldApt); await attach(); }
  finally { await run(["rm", "--force", holder], true); }
  for (const name of ["debian", "ubuntu"]) await guest(["docker", "exec", `apt-${name}`, "sh", "-ceu", "cd /tmp; apt-get download hello >/tmp/replaced.log 2>&1 || { cat /tmp/replaced.log; exit 1; }; sha256sum -c /tmp/cold.sha; rm hello*.deb"]);
  console.log("already-running nested APT consumers survive cache replacement/new IP: PASS");
  await run(["stop", apt]);
  for (const name of ["debian", "ubuntu"]) {
    const failure = await guest(["docker", "exec", `apt-${name}`, "sh", "-ceu", "cd /tmp; apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=5 download hello"], true);
    assert.notEqual(failure.exitCode, 0, `${name} must not bypass an unavailable configured APT proxy`);
  }
  const digests: string[] = [];
  for (const base of ["debian:bookworm-slim", "ubuntu:24.04"]) digests.push((await guest(["docker", "image", "inspect", base, "--format", "{{index .RepoDigests 0}}"])).stdout.trim());
  await guest(["docker", "rm", "--force", "apt-debian", "apt-ubuntu"]);
  await guest(["docker", "image", "rm", "--force", "debian:bookworm-slim", "ubuntu:24.04"]);
  await guest(["docker", "image", "prune", "--all", "--force"]);
  await run(["network", "disconnect", egress, registry]);
  for (const digest of digests) await guest(["docker", "pull", digest]);
  console.log("fresh nested Docker image data served by warm registry with all cache Internet access removed: PASS");
  await run(["stop", registry]);
  const failedPull = await guest(["docker", "pull", "alpine:3.22"], true);
  assert.notEqual(failedPull.exitCode, 0, "Docker must not bypass its unavailable mirror");
  assert.match(failedPull.stderr, /127\.0\.0\.1|connection refused|mirror|timeout|EOF/i);
  console.log("actual nested APT outage fails closed; default Docker Hub fallback blocked: PASS");
} catch (error) {
  if (workspace) {
    const diagnostic = await runtime.run(workspace, ["sh", "-c", "cat /home/dim/.local/state/dim/services/host-mirrors.log; docker info --format '{{json .RegistryConfig}}'; sudo cat /var/log/dockerd.log | tail -30; ls -l /var/run/*sock"], { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (diagnostic) console.error(diagnostic.stdout, diagnostic.stderr);
    const api = await runtime.run(workspace, ["node", "--input-type=module", "-e", `import {request} from 'node:http';const r=request({socketPath:'/var/run/docker.sock',path:'/v1.44/info'},s=>{console.log(s.statusCode,s.headers);let x='';s.on('data',c=>x+=c);s.on('end',()=>console.log(JSON.parse(x).RegistryConfig));});r.on('error',console.error);r.end();`]);
    console.error(api.stdout, api.stderr);
  }
  throw error;
} finally {
  if (workspace) await service.discard(workspace.name, workspace.id).catch(async () => runtime.remove(workspace!, { keepData: false }));
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  for (const name of [registry, apt, npm, pypi, `${prefix}-address-holder`]) await run(["rm", "--force", name], true);
  for (const volume of volumes) await run(["volume", "rm", volume], true);
  await run(["network", "rm", network], true);
  await run(["network", "rm", egress], true);
  await rm(root, { recursive: true, force: true });
}
