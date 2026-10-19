#!/usr/bin/env -S tsx
/** Explicit disposable Sysbox + Docker/APT cache verification; no installed service is changed. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
const token = randomUUID().slice(0, 8), prefix = `dim-mirrors-smoke-${token}`;
const root = await mkdtemp(join(tmpdir(), prefix));
const runner = new ProcessRunner(), runtime = new ContainerWorkspaceRuntime(runner), store = new WorkspaceStore(join(root, "workspaces"));
const service = new WorkspaceService(store, runtime, acquireWorkspaceSource);
const registry = `${prefix}-registry`, apt = `${prefix}-apt`, network = `${prefix}-network`, egress = `${prefix}-egress`, volumes = [`${prefix}-registry-data`, `${prefix}-apt-data`];
let workspace: Awaited<ReturnType<typeof service.create>> | undefined;
async function run(args: string[], allowedFailure = false) {
  const result = await runner.run("docker", args, { signal: AbortSignal.timeout(180_000) });
  if (!allowedFailure) assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`); return result;
}
const registryImage = "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33";
const aptImage = "sameersbn/apt-cacher-ng@sha256:58e74113cfac7e593201444648c105351cbfce7538bfb36dcafdc9479b2aefcc";
async function address(name: string) { return (await run(["inspect", name, "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`])).stdout.trim(); }
async function startApt() { await run(["create", "--name", apt, "--network", network, "--mount", `type=volume,src=${volumes[1]},dst=/var/cache/apt-cacher-ng`, aptImage]); await run(["network", "connect", egress, apt]); await run(["start", apt]); }
async function attach() {
  assert(workspace);
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: root, store, service, signal: AbortSignal.timeout(60_000), hostGateway: (record) => runtime.hostGateway(record) };
  await artifact.attachWorkspaceMirrors(workspace, context, { registry: { host: await address(registry), port: 5000 }, apt: { host: await address(apt), port: 3142 } });
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
  for (const name of [registry, apt, `${prefix}-address-holder`]) await run(["rm", "--force", name], true);
  for (const volume of volumes) await run(["volume", "rm", volume], true);
  await run(["network", "rm", network], true);
  await run(["network", "rm", egress], true);
  await rm(root, { recursive: true, force: true });
}
