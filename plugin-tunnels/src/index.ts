import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { UserError, type WorkspaceHostPlugin, type WorkspaceService } from "@slop-lab/dim-core/workspace";
import { TunnelStore, namePattern, parseRoute, validPort } from "./store.js";
import { serveTunnels } from "./server.js";
export { serveTunnels } from "./server.js";
export { TunnelStore } from "./store.js";

function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || result[key] !== undefined) throw new UserError("expected unique --option VALUE pairs");
    result[key] = value;
  }
  return result;
}
function port(value: string | undefined, fallback?: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!validPort(result)) throw new UserError("port must be 1..65535"); return result;
}
function quoted(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export const hostPlugin: WorkspaceHostPlugin = {
  name: "tunnels", commands: [{ name: "tunnel", description: "Manage persistent scoped TCP and UDP tunnels" }],
  run: runTunnels
};
export async function runTunnels(args: string[], context: { signal: AbortSignal; service: Pick<WorkspaceService, "show" | "exec"> }): Promise<void> {
    const [, command, ...rest] = args;
    const workspace = command === "attach" ? rest.shift() : undefined;
    const options = flags(rest), file = options["--config"];
    if (!file) throw new UserError("tunnel commands require --config PRIVATE_FILE; start with dim tunnel prepare --config FILE");
    const accepted: Record<string, readonly string[]> = {
      prepare: ["--config", "--username"], list: ["--config"],
      add: ["--config", "--name", "--protocol", "--target-host", "--target-port"], remove: ["--config", "--name"],
      serve: ["--config", "--listen", "--port", "--ui-port"], attach: ["--config", "--route", "--endpoint", "--local-port"]
    };
    if (!command || !accepted[command] || Object.keys(options).some((key) => !accepted[command]?.includes(key))) throw new UserError("unknown tunnel command or option");
    const store = new TunnelStore(file);
    if (command === "prepare") { await store.initialize(options["--username"] ?? "operator"); console.log(JSON.stringify({ file, prepared: true })); return; }
    if (command === "list") { const config = await store.read(); console.log(JSON.stringify({ routes: config.routes, grants: Object.values(config.grants) })); return; }
    if (command === "add") {
      const name = options["--name"]; if (!name || !namePattern.test(name)) throw new UserError("add requires --name NAME");
      const route = parseRoute({ protocol: options["--protocol"], host: options["--target-host"], port: port(options["--target-port"]) });
      await store.update((value) => { value.routes[name] = route; }); console.log(JSON.stringify({ name, ...route })); return;
    }
    if (command === "remove") {
      const name = options["--name"]; if (!name || !namePattern.test(name)) throw new UserError("remove requires --name NAME");
      await store.update((value) => { delete value.routes[name]; for (const [token, grant] of Object.entries(value.grants)) if (grant.route === name) delete value.grants[token]; }); return;
    }
    if (command === "serve") {
      const server = await serveTunnels(store, { async current(grant) {
        try { const record = await context.service.show(grant.workspaceName); return record.id === grant.workspaceId && record.runtimeStatus === "running"; } catch { return false; }
      } }, { relayHost: options["--listen"] ?? "127.0.0.1", relayPort: port(options["--port"], 8742), operatorPort: port(options["--ui-port"], 8743) });
      console.log(JSON.stringify({ relayPort: server.relayPort, operatorUrl: `http://127.0.0.1:${server.operatorPort}` }));
      try { await new Promise<void>((resolve) => { if (context.signal?.aborted) resolve(); else context.signal?.addEventListener("abort", () => resolve(), { once: true }); }); }
      finally { await server.close(); } return;
    }
    if (command === "attach") {
      if (!workspace) throw new UserError("attach requires WORKSPACE");
      const name = options["--route"], endpoint = options["--endpoint"], localPort = port(options["--local-port"]);
      if (!name || !namePattern.test(name) || !endpoint) throw new UserError("attach requires --route NAME --endpoint HOST:PORT --local-port PORT");
      const address = new URL(`tcp://${endpoint}`);
      if (!address.hostname || !address.port || address.username || address.password || address.pathname || address.search || address.hash) throw new UserError("endpoint must be HOST:PORT");
      const record = await context.service.show(workspace);
      if (record.runtimeStatus !== "running") throw new UserError("start the workspace before attaching a tunnel");
      const token = randomBytes(32).toString("base64url");
      const config = await store.update((value) => {
        if (!value.routes[name]) throw new UserError(`unknown tunnel route '${name}'`);
        // Re-attaching replaces this workspace's prior credential for the route.
        for (const [old, grant] of Object.entries(value.grants)) if (grant.workspaceId === record.id && grant.route === name) delete value.grants[old];
        value.grants[token] = { workspaceId: record.id, workspaceName: record.name, route: name, localPort };
      });
      const route = config.routes[name]; if (!route) throw new Error("route disappeared");
      const value = { name, protocol: route.protocol, localPort, token };
      const payload = ["set -euo pipefail", 'mkdir -p "$HOME/.local/share/dim-tunnels" "$HOME/.config/dim"', 'chmod 0700 "$HOME/.local/share/dim-tunnels"'];
      for (const file of ["guest.mjs", "install.mjs"]) {
        const asset = await readFile(new URL(`./assets/${file}`, import.meta.url));
        payload.push(`printf '%s' '${asset.toString("base64")}' | base64 -d >"$HOME/.local/share/dim-tunnels/${file}"`);
      }
      payload.push(`node "$HOME/.local/share/dim-tunnels/install.mjs" ${quoted(endpoint)} ${quoted(JSON.stringify(value))}`,
        "dim-workspace service remove tunnels", 'dim-workspace service register --name tunnels -- node "$HOME/.local/share/dim-tunnels/guest.mjs" "$HOME/.config/dim/tunnels.json"', "dim-workspace service resume");
      const script = payload.join("\n");
      try {
        const code = await context.service.exec(workspace, ["bash", "-s"], { workspaceId: record.id, stdin: Readable.from([script]), stdout: process.stdout, stderr: process.stderr, signal: context.signal });
        if (code !== 0) throw new UserError(`guest tunnel setup exited ${code}`);
      } catch (error) { await store.update((value) => { delete value.grants[token]; }); throw error; }
      console.log(JSON.stringify({ workspace: record.name, route: name, protocol: route.protocol, localPort })); return;
    }
    throw new UserError("usage: dim tunnel prepare|serve|add|remove|list|attach --config FILE [OPTIONS]");
  }
