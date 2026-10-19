import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { mkdir, open, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLifecycleLock, atomicWrite } from "@slop-lab/dim-core";
import type { WorkspaceHostPluginContext, WorkspaceRecord } from "@slop-lab/dim-core/workspace";
import type { MirrorRelayConfig } from "./relay.js";
import { object, parseRelayConfig, privateJson } from "./relay-state.js";
import { cacheKinds, DOCKER_HUB_DIRECT_HOSTNAMES, type CacheKind, type CacheEndpoints } from "./cache-routing.js";

interface RelayReady { ports: Record<CacheKind, number> }
async function control(config: MirrorRelayConfig, port: number, close = false) {
  return new Promise<boolean>((resolve) => {
    const outgoing = request({ hostname: config.listen, port, path: close ? "/__dim/close" : "/__dim/health", method: close ? "POST" : "GET",
      headers: { authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(1_000) }, (response) => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", (chunk: string) => { if (body.length + chunk.length > 4096) outgoing.destroy(); else body += chunk; });
      response.on("error", () => resolve(false)); response.on("end", () => {
        if (close) { resolve(response.statusCode === 200); return; }
        try { const value = object(JSON.parse(body)); resolve(response.statusCode === 200 && value.workspaceId === config.workspaceId && value.configurationId === config.configurationId); } catch { resolve(false); }
      });
    }); outgoing.on("error", () => resolve(false)); outgoing.end();
  });
}
async function ready(root: string, config: MirrorRelayConfig): Promise<RelayReady | undefined> {
  try { const value = object(await privateJson(join(root, "ready.json")));
    const ports = object(value.ports);
    if (value.configurationId !== config.configurationId || cacheKinds.some((kind) => typeof ports[kind] !== "number" || !Number.isSafeInteger(ports[kind]) || Number(ports[kind]) < 1 || Number(ports[kind]) > 65535)) return;
    if (await control(config, Number(ports.docker))) return { ports: ports as Record<CacheKind, number> };
  } catch { return; }
  return;
}
export async function ensureWorkspaceRelay(root: string, input: Omit<MirrorRelayConfig, "controlToken" | "configurationId">, signal: AbortSignal): Promise<RelayReady> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const release = await acquireLifecycleLock({ root, name: "relay", description: "workspace mirror relay", options: { signal } });
  try {
    try {
      const old = parseRelayConfig(await privateJson(join(root, "relay.json"))), current = await ready(root, old);
      if (current) {
        const { controlToken: _token, configurationId: _id, ...previous } = old;
        if (isDeepStrictEqual(previous, input)) return current;
        if (previous.listen === input.listen && previous.workspaceId === input.workspaceId && previous.workspaceStateRoot === input.workspaceStateRoot && previous.workspaceName === input.workspaceName) {
          const next = { ...input, controlToken: old.controlToken, configurationId: randomUUID() };
          await atomicWrite(join(root, "relay.json"), next);
          for (let attempt = 0; attempt < 100; attempt++) { const updated = await ready(root, next); if (updated) return updated; await new Promise<void>((resolve) => setTimeout(resolve, 50)); }
          throw new Error("workspace mirror relay configuration did not refresh");
        }
        await control(old, current.ports.docker, true);
        for (let attempt = 0; attempt < 100 && await control(old, current.ports.docker); attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    const config = parseRelayConfig({ ...input, controlToken: randomBytes(32).toString("base64url"), configurationId: randomUUID() });
    await atomicWrite(join(root, "relay.json"), config);
    const log = await open(join(root, "relay.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./relay-cli.js", import.meta.url)), join(root, "relay.json")], { detached: true, stdio: ["ignore", log.fd, log.fd] });
      let failure: Error | undefined; child.on("error", (error) => { failure = error; }); child.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        signal.throwIfAborted(); const current = await ready(root, config); if (current) return current;
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`workspace mirror relay failed; inspect ${join(root, "relay.log")}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("workspace mirror relay did not become ready");
    } finally { await log.close(); }
  } finally { await release(); }
}
export async function attachWorkspaceMirrors(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext, endpoints: Pick<MirrorRelayConfig, "endpoints">): Promise<void> {
  if (!workspace.initialized || workspace.phase !== "running") return;
  if (!context.hostGateway) throw new Error("workspace runtime does not provide a private mirror gateway");
  const attachmentRoot = join(context.stateRoot, "plugins/host-mirrors/workspaces", workspace.id);
  const release = await acquireLifecycleLock({ root: attachmentRoot, name: "attachment", description: "workspace mirror attachment", options: { signal: context.signal } });
  try {
    const current = await context.store.read(workspace.name);
    if (current.id !== workspace.id || current.phase !== "running" || !current.initialized) throw new Error("workspace mirror identity changed before attachment");
    const listen = await context.hostGateway(workspace);
    const { endpoints: targets } = endpoints;
    const relay = await ensureWorkspaceRelay(attachmentRoot, {
      workspaceStateRoot: context.store.root, workspaceName: workspace.name, workspaceId: workspace.id, listen, endpoints: targets
    }, context.signal);
    const proxy = await readFile(new URL("./guest-proxy.js", import.meta.url), "utf8"), setup = await readFile(new URL("./guest-setup.js", import.meta.url), "utf8");
    const payload = { endpoints: Object.fromEntries(cacheKinds.map((kind) => [kind, `http://${listen}:${relay.ports[kind]}/`])) as CacheEndpoints, proxy, setup, blockedHostnames: [...DOCKER_HUB_DIRECT_HOSTNAMES] };
    const script = `${setup}\nconst chunks=[];for await (const chunk of process.stdin) chunks.push(chunk);await installGuestMirrors(JSON.parse(Buffer.concat(chunks).toString('utf8')));`;
    const status = await context.service.exec(workspace.name, ["node", "--input-type=module", "-e", script], { workspaceId: workspace.id, signal: context.signal, stdin: Readable.from([JSON.stringify(payload)]) });
    if (status !== 0) throw new Error("workspace mirror attachment failed; workspace data was preserved");
  } finally { await release(); }
}
