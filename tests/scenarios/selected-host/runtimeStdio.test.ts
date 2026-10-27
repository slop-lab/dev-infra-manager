import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { expect, it } from "vitest";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { openWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannel.js";
import { workspaceServiceMarker } from "../../../packages/host/core/src/workspace/serviceChannelGuest.js";
import { parseLlmChannelEvidence, parseWorkspaceDiscoveryEvidence } from "./runtimeEvidence.js";

const image = process.env.DIM_SELECTED_HOST_STDIO_IMAGE;

it.skipIf(!image)("carries generic discovery and LLM HTTP through fresh network-none guest stdio bridges", async () => {
  if (!image) throw new Error("provide DIM_SELECTED_HOST_STDIO_IMAGE");
  await exercise(image, false);
}, 60_000);

it.skipIf(!image)("ignores a real nested 172.20.0.1 shadow for discovery and LLM named-service traffic", async () => {
  if (!image) throw new Error("provide DIM_SELECTED_HOST_STDIO_IMAGE");
  await exercise(image, true);
}, 60_000);

async function exercise(reviewedImage: string, collision: boolean): Promise<void> {
  const workspace = { workspaceId: randomUUID(), workspaceName: `dim-smoke-${randomUUID().slice(0, 8)}`,
    workspaceSourceSha: "b".repeat(40) };
  const generation = "c".repeat(64), calls: string[] = [];
  const discovery = { schemaVersion: 1,
    workspace: { id: workspace.workspaceId, name: workspace.workspaceName, runtime: "container", phase: "running",
      source: { commit: workspace.workspaceSourceSha } }, freshness: { bridgeGeneration: generation },
    pluginSet: ["native-git", "host-llm-router", "kvm"],
    services: [{ owner: "core", name: "workspace" }, { owner: "native-git", name: "native-git" },
      { owner: "host-llm-router", name: "llm-router" }],
    capabilities: ["direct-access", "vm-fd-verification"].map((name) => ({ owner: "kvm", name,
      state: "blocked", access: { kind: "none" }, reason: { code: "runtime-grant-required", message: "Use container-kvm" } })) };
  const core = await listener((request, response) => {
    calls.push(`core ${request.url}`);
    response.writeHead(request.url === "/v1/discovery" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/v1/discovery" ? discovery : { error: "not found" }));
  });
  const llm = await listener((request, response) => {
    calls.push(`llm ${request.url}`);
    const allowed = request.url === "/v1/models" && request.headers.authorization === "Bearer scoped-llm-token";
    response.writeHead(allowed ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify(allowed ? { data: [{ id: "reviewed-model" }] } : { error: "denied" }));
  });
  try {
    if (core.port === 19420 || llm.port === 19420) throw new Error("host fixture port conflicts with the guest service port");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bridge = await openBridge(reviewedImage, { workspace: core.origin, "llm-router": llm.origin }, collision);
      try {
        expect(bridge.networkMode).toBe("none");
        const result = await bridge.request(core.port, collision);
        expect(result.directHostLoopbackReachable).toBe(false);
        expect(result.shadowPaths).toEqual(collision ? ["/v1/discovery", "/v1/models"] : []);
        expect(result.collisionRoute).toMatch(collision ? /^local 172\.20\.0\.1 dev lo\b/ : /^$/);
        expect(parseWorkspaceDiscoveryEvidence(JSON.stringify(result.discovery), { ...workspace,
          requiredPlugins: ["native-git", "host-llm-router", "kvm"] })).toEqual({ generation });
        expect(parseLlmChannelEvidence(JSON.stringify(result.llm))).toEqual({
          endpoint: "http://127.0.0.1:19420/services/llm-router", status: 200, modelCount: 1
        });
      } finally { await bridge.close(); }
    }
    expect(calls).toEqual(["core /v1/discovery", "llm /v1/models", "core /v1/discovery", "llm /v1/models"]);
  } finally { await Promise.all([close(core.server), close(llm.server)]); }
}

type FixtureServer = { readonly server: Server; readonly port: number; readonly origin: string };
async function listener(handler: RequestListener): Promise<FixtureServer> {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener did not bind TCP");
  return { server, port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function openBridge(reviewedImage: string, services: Readonly<Record<string, string>>, collision: boolean) {
  const runner = new ProcessRunner(), name = `dim-stdio-${randomUUID()}`, controller = new AbortController();
  const channel = openWorkspaceServiceChannel({ token: randomUUID(), port: 19420, signal: controller.signal,
    current: async () => true, resolve: async (service) => services[service],
    exec: async (command, options) => {
      if (!command.includes(workspaceServiceMarker)) {
        const removed = await runner.run("docker", ["rm", "--force", name], { ...options, signal: AbortSignal.timeout(10_000) });
        return removed.exitCode;
      }
      const isolation = ["run", "--name", name, "--network", "none", "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "64", "-i"];
      if (!collision) return runner.runStreaming("docker", [...isolation,
        "--entrypoint", command[0] ?? "node", reviewedImage, ...command.slice(1)], options);
      const wrapper = `const{spawn,spawnSync}=require("node:child_process"),http=require("node:http");for(const args of [["link","add","dimshadow","type","bridge"],["addr","add","172.20.0.1/16","dev","dimshadow"],["link","set","dimshadow","up"]]){const r=spawnSync("ip",args,{stdio:"inherit"});if(r.status!==0)process.exit(86)}const shadow=http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({source:"nested-bridge-shadow",path:q.url}))});shadow.listen(18318,"172.20.0.1",()=>{const child=spawn(process.argv[1],process.argv.slice(2),{stdio:"inherit"});child.on("exit",code=>{shadow.close();process.exitCode=code??1})});`;
      return runner.runStreaming("docker", [...isolation, "--cap-add", "NET_ADMIN", "--user", "0:0",
        "--entrypoint", "node", reviewedImage, "-e", wrapper, command[0] ?? "node", ...command.slice(1)], options);
    } });
  await channel.ready;
  const inspected = await runner.run("docker", ["inspect", "--format", "{{.HostConfig.NetworkMode}}", name]);
  if (inspected.exitCode !== 0) { await channel.close(); throw new Error("guest bridge container could not be inspected"); }
  return { networkMode: inspected.stdout.trim(), async request(hostPort: number, expectCollision: boolean) {
    const script = `const{execFileSync}=require("node:child_process"),endpoint="http://127.0.0.1:19420";(async()=>{let directHostLoopbackReachable=false;try{await fetch("http://127.0.0.1:${hostPort}/direct",{signal:AbortSignal.timeout(500)});directHostLoopbackReachable=true}catch{}const shadowPaths=[];let collisionRoute="";if(${JSON.stringify(expectCollision)}){collisionRoute=execFileSync("ip",["route","get","172.20.0.1"],{encoding:"utf8"}).trim();for(const path of ["/v1/discovery","/v1/models"]){const value=await(await fetch("http://172.20.0.1:18318"+path)).json();if(value.source==="nested-bridge-shadow")shadowPaths.push(value.path)}}const discovery=await(await fetch(endpoint+"/services/workspace/v1/discovery")).json();const response=await fetch(endpoint+"/services/llm-router/v1/models",{headers:{authorization:"Bearer scoped-llm-token"}});const body=await response.json();process.stdout.write(JSON.stringify({directHostLoopbackReachable,shadowPaths,collisionRoute,discovery,llm:{schemaVersion:1,endpoint:endpoint+"/services/llm-router",status:response.status,modelCount:Array.isArray(body.data)?body.data.length:0}}))})().catch(()=>process.exit(2))`;
    const result = await runner.run("docker", ["exec", name, "node", "-e", script]);
    if (result.exitCode !== 0) throw new Error("guest HTTP requests through the stdio bridge failed");
    return parseGuestResult(JSON.parse(result.stdout));
  }, async close() { controller.abort(); await channel.close(); } };
}

function parseGuestResult(value: unknown): { readonly directHostLoopbackReachable: boolean; readonly shadowPaths: readonly string[]; readonly collisionRoute: string; readonly discovery: unknown; readonly llm: unknown } {
  if (!isObject(value) || typeof value.directHostLoopbackReachable !== "boolean"
    || !Array.isArray(value.shadowPaths) || !value.shadowPaths.every((path) => typeof path === "string")
    || typeof value.collisionRoute !== "string"
    || !("discovery" in value) || !("llm" in value)) throw new Error("guest bridge result is invalid");
  return { directHostLoopbackReachable: value.directHostLoopbackReachable,
    shadowPaths: value.shadowPaths, collisionRoute: value.collisionRoute, discovery: value.discovery, llm: value.llm };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
