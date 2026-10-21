/** Disposable Headscale acceptance. Uses no operator Tailscale socket, keys or node state. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ProcessRunner } from "@slop-lab/dim-host-core";
import { ContainerWorkspaceRuntime, workspaceRuntimeResources } from "@slop-lab/dim-host-core/workspace";
import { configureGateway, gatewayNames } from "../../../packages/host/plugins/tailscale/src/state.js";
import { ensureGateway, gatewayStatus } from "../../../packages/host/plugins/tailscale/src/gateway.js";
import { attachTailnet, detachTailnet } from "../../../packages/host/plugins/tailscale/src/routing.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";
const selectedImage = process.env.DIM_TAILNET_WORKSPACE_IMAGE;
if (!selectedImage) throw new Error("DIM_TAILNET_WORKSPACE_IMAGE must select a reviewed locally prepared workspace image");
const headscaleImage = "docker.io/headscale/headscale:0.29.3@sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72";
const runner = new ProcessRunner(), scratch = await mkdtemp(join(tmpdir(), "dim-tailnet-live-")), prefix = `dim-tailnet-test-${randomUUID()}`;
async function docker(args: string[], input?: string): Promise<string> {
  const result = await runner.run("docker", args, { signal: AbortSignal.timeout(120_000), ...(input === undefined ? {} : { stdin: Readable.from([input]) }) });
  if (result.exitCode !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}
const image = JSON.parse(await docker(["image", "inspect", selectedImage]))[0].Id as string;
const root = join(scratch, "host"), peerRoot = join(scratch, "peer");
const state = await configureGateway(root, { hostname: "gateway", loginServer: `http://${prefix}` });
const peerState = await configureGateway(peerRoot, { hostname: "peer", loginServer: `http://${prefix}` });
const record = workspaceRecord(prefix, { id: randomUUID(), image, initialized: false, resources: { cpuCount: "2", memory: "2g", pidsLimit: "1024" } });
const runtime = new ContainerWorkspaceRuntime(runner), context = { stateRoot: root, runner, cleanupRunner: runner };
let headscale: string | undefined, gateway: string | undefined, peer: string | undefined, server: string | undefined;
try {
  gateway = await ensureGateway(runner, state);
  const configuration = join(scratch, "headscale"); await mkdir(configuration); await mkdir(join(configuration, "data"));
  await writeFile(join(configuration, "config.json"), JSON.stringify({ server_url: `http://${prefix}`, listen_addr: "0.0.0.0:80", metrics_listen_addr: "127.0.0.1:9090", grpc_listen_addr: "127.0.0.1:50443", noise: { private_key_path: "/var/lib/headscale/noise.key" }, prefixes: { v4: "100.64.0.0/10", v6: "fd7a:115c:a1e0::/48", allocation: "sequential" }, database: { type: "sqlite", sqlite: { path: "/var/lib/headscale/db.sqlite" } }, derp: { server: { enabled: false }, urls: ["https://controlplane.tailscale.com/derpmap/default"], auto_update_enabled: false }, dns: { magic_dns: true, base_domain: "dim-test.invalid", override_local_dns: true, nameservers: { global: ["1.1.1.1"] } }, unix_socket: "/var/lib/headscale/headscale.sock", policy: { mode: "file", path: "" }, log: { level: "warn" } }));
  headscale = await docker(["run", "--detach", "--name", prefix, "--network", gatewayNames(state).network, "--label", `dim.test-id=${prefix}`, "--mount", `type=bind,source=${configuration}/config.json,target=/etc/headscale/config.json,readonly`, "--mount", `type=bind,source=${configuration}/data,target=/var/lib/headscale`, headscaleImage, "serve"]);
  for (let attempt = 0; ; attempt++) {
    const result = await runner.run("docker", ["exec", headscale, "headscale", "users", "list", "--output", "json"]);
    if (result.exitCode === 0) break;
    if (attempt > 40) throw new Error(`Headscale did not become ready: ${await docker(["logs", headscale])}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await docker(["exec", headscale, "headscale", "users", "create", "dimtest"]);
  const keyResult = JSON.parse(await docker(["exec", headscale, "headscale", "preauthkeys", "create", "--user", "1", "--reusable", "--expiration", "1h", "--output", "json"])) as { key: string };
  assert(keyResult.key);
  async function login(id: string, hostname: string): Promise<void> {
    await docker(["exec", "-i", id, "sh", "-ec", `umask 077; trap 'rm -f /tmp/dim-test-auth' EXIT; cat >/tmp/dim-test-auth; tailscale up --auth-key=file:/tmp/dim-test-auth --login-server=http://${prefix} --hostname=${hostname} --accept-dns=false --netfilter-mode=off --timeout=90s`], keyResult.key);
  }
  await login(gateway, "gateway");
  const peerNames = gatewayNames(peerState);
  await docker(["volume", "create", "--label", `dim.test-id=${prefix}`, peerNames.volume]);
  peer = await docker(["run", "--detach", "--name", peerNames.container, "--hostname", "peer", "--network", gatewayNames(state).network,
    "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/var/run", "--cap-add", "NET_ADMIN", "--device", "/dev/net/tun",
    "--mount", `type=volume,source=${peerNames.volume},target=/var/lib/tailscale`, "--label", `dim.test-id=${prefix}`,
    "--entrypoint", "tailscaled", peerState.image, "--state=/var/lib/tailscale/tailscaled.state", "--socket=/var/run/tailscale/tailscaled.sock", "--tun=tailscale0", "--port=41641"]);
  await login(peer, "peer");
  const peerIP = await docker(["exec", peer, "tailscale", "ip", "-4"]);
  server = await docker(["run", "--detach", "--name", `${prefix}-http`, "--network", `container:${peer}`, "--label", `dim.test-id=${prefix}`, "--entrypoint", "node", image, "-e", "require('node:http').createServer((req,res)=>res.end('tailnet-ok')).listen(8088,'0.0.0.0')"]);
  assert.equal(await docker(["exec", peer, "busybox", "wget", "-qO-", "-T", "5", "http://127.0.0.1:8088/"]), "tailnet-ok");
  await runtime.create(record); await runtime.start(record);
  const name = workspaceRuntimeResources(record).container;
  // Transfer a reviewed local image through a stream; the agent receives no host mount/socket or Tailscale credential.
  const archive = join(scratch, "agent.tar"); await docker(["image", "save", "--output", archive, "alpine:3.23"]);
  const { createReadStream } = await import("node:fs");
  const loaded = await runner.run("docker", ["exec", "-i", name, "docker", "load"], { stdin: createReadStream(archive), signal: AbortSignal.timeout(60_000) });
  assert.equal(loaded.exitCode, 0);
  const runningAgent = await docker(["exec", name, "docker", "run", "--detach", "--pull=never", "alpine:3.23", "sleep", "600"]);
  const beforeAttach = await docker(["exec", name, "docker", "inspect", "--format", "{{.State.StartedAt}}", runningAgent]);
  await attachTailnet(record, context);
  assert.equal((await runtime.inspect(record))?.running, true);
  assert.equal(await docker(["exec", name, "docker", "inspect", "--format", "{{.State.Running}} {{.State.StartedAt}}", runningAgent]), `true ${beforeAttach}`);
  const reply = await docker(["exec", name, "node", "--input-type=module", "-e", `const r=await fetch('http://peer.dim-test.invalid:8088/',{signal:AbortSignal.timeout(15000)});console.log(await r.text());`]);
  assert.equal(reply, "tailnet-ok");
  const short = await docker(["exec", name, "node", "--input-type=module", "-e", `import{lookup}from'node:dns/promises';console.log((await lookup('peer',{family:4})).address)`]);
  assert.equal(short, peerIP);
  const agent = await docker(["exec", name, "docker", "run", "--rm", "--pull=never", "alpine:3.23", "sh", "-ec", "nslookup peer.dim-test.invalid >/dev/null; wget -qO- -T 15 http://peer.dim-test.invalid:8088/"]);
  assert.equal(agent, "tailnet-ok");
  const beforeGatewayIP = await docker(["exec", gateway, "tailscale", "ip", "-4"]);
  await docker(["rm", "--force", gateway]);
  gateway = await ensureGateway(runner, state);
  for (let attempt = 0; ; attempt++) {
    if ((await gatewayStatus(runner, state)).BackendState === "Running") break;
    if (attempt > 80) throw new Error("retained gateway authentication did not resume");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(await docker(["exec", gateway, "tailscale", "ip", "-4"]), beforeGatewayIP);
  await attachTailnet(record, context);
  assert.equal(await docker(["exec", name, "docker", "inspect", "--format", "{{.State.Running}} {{.State.StartedAt}}", runningAgent]), `true ${beforeAttach}`);
  assert.equal(await docker(["exec", name, "node", "--input-type=module", "-e", `console.log(await(await fetch('http://peer.dim-test.invalid:8088/',{signal:AbortSignal.timeout(15000)})).text())`]), "tailnet-ok");
  const status = await gatewayStatus(runner, state); assert.equal(status.BackendState, "Running");
  console.log("tailscale-gateway: disposable Headscale, workspace MagicDNS/TCP, nested agent DNS/TCP, running-agent continuity and retained gateway authentication PASS");
} catch (error) {
  for (const [label, id] of [["peer", peer], ["gateway", gateway]]) if (id) {
    console.error(`${label} network diagnostics:`, await docker(["exec", id, "sh", "-c", "tailscale status; ip -4 addr; ip -4 rule; ip -4 route show table 52; iptables-nft -S; netstat -lnt"]).catch((diagnosticError: unknown) => String(diagnosticError)));
  }
  throw error;
} finally {
  await detachTailnet(record, { keepData: false }, context).catch(() => {});
  await runtime.remove(record, { keepData: false });
  if (server) await docker(["rm", "--force", server]);
  if (headscale) await docker(["rm", "--force", headscale]);
  if (peer) await docker(["rm", "--force", peer]);
  if (gateway) await docker(["rm", "--force", gateway]);
  for (const selected of [peerState, state]) {
    const names = gatewayNames(selected);
    await docker(["volume", "rm", names.volume]);
    if (selected === state) await docker(["network", "rm", names.network]);
  }
  await rm(scratch, { recursive: true, force: true });
}
