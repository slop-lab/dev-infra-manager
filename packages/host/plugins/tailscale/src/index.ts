import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { UserError, acquireLifecycleLock } from "@slop-lab/dim-host-core";
import type { WorkspaceHostPlugin, WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION } from "@slop-lab/dim-contracts-external-url";
import { tailscaleIngressDriver } from "./ingress.js";
import { configureGateway, readGatewayState } from "./state.js";
import { ensureGateway, gatewayStatus, inspectGateway, object, replaceGatewayImage } from "./gateway.js";
import { attachTailnet, detachTailnet } from "./routing.js";

const usage = "usage: dim tailscale configure [--hostname NAME] [--login-server URL] [--image DIGEST] | dim tailscale up [--auth-key-file ABSOLUTE_PATH] | dim tailscale status";
function options(args: string[], allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!, value = args[i + 1];
    if (!allowed.includes(name) || result[name] !== undefined || !value || value.startsWith("--")) throw new UserError(usage);
    result[name] = value;
  }
  return result;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function runTailscaleCommand(args: string[], context: Pick<WorkspaceHostPluginContext, "runner" | "stateRoot" | "signal">): Promise<void> {
  if (args[1] === "status" && args.length === 2) {
    const state = await readGatewayState(context.stateRoot);
    console.log(JSON.stringify(state ? await gatewayStatus(context.runner, state) : { BackendState: "Unconfigured" }, null, 2)); return;
  }
  if (args[1] !== "configure" && args[1] !== "up") throw new UserError(usage);
  const input = options(args.slice(2), args[1] === "configure" ? ["--hostname", "--login-server", "--image"] : ["--auth-key-file"]);
  const release = await acquireLifecycleLock({ root: context.stateRoot, name: "tailscale-routing", description: "Tailscale gateway configuration" });
  try {
    if (args[1] === "configure") {
      const state = await configureGateway(context.stateRoot, {
        ...(input["--hostname"] ? { hostname: input["--hostname"] } : {}),
        ...(input["--login-server"] ? { loginServer: input["--login-server"] } : {}),
        ...(input["--image"] ? { image: input["--image"] } : {})
      });
      console.log(`Tailscale gateway configured: ${state.hostname}. Run dim tailscale up to connect.`); return;
    }
    let key: string | undefined;
    const keyFile = input["--auth-key-file"];
    if (keyFile) {
      if (!isAbsolute(keyFile)) throw new UserError("Tailscale auth-key file must use an absolute path");
      const info = await lstat(keyFile);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new UserError("Tailscale auth-key file must be a private, operator-owned regular file");
      key = (await readFile(keyFile, "utf8")).trim();
      if (!key || /\s/.test(key)) throw new UserError("invalid Tailscale auth-key file");
    }
    const state = await readGatewayState(context.stateRoot) ?? await configureGateway(context.stateRoot);
    if (await context.runner.runStreaming("docker", ["pull", state.image], { signal: context.signal }) !== 0) throw new UserError("could not pull pinned Tailscale gateway image");
    await replaceGatewayImage(context.runner, state);
    const id = await ensureGateway(context.runner, state);
    const up = ["tailscale", "up", "--netfilter-mode=off", "--accept-dns=false", `--hostname=${state.hostname}`, "--timeout=5m", ...(state.loginServer ? [`--login-server=${state.loginServer}`] : [])];
    const temporary = `/tmp/dim-auth-${randomUUID()}`;
    const command = key === undefined ? ["exec", id, ...up] : ["exec", "-i", id, "sh", "-ec", `umask 077; trap 'rm -f ${temporary}' EXIT; cat > ${temporary}; ${[...up, `--auth-key=file:${temporary}`].map(quote).join(" ")}`];
    if (await context.runner.runStreaming("docker", command, { signal: context.signal, ...(key === undefined ? {} : { stdin: Readable.from([key]) }) }) !== 0) throw new UserError("Tailscale gateway login failed; run dim tailscale up to retry");
    console.log("Tailscale gateway connected. Workspace access reconciles its tailnet route and DNS automatically.");
  } finally { await release(); }
}
export const hostPlugin: WorkspaceHostPlugin = {
  name: "tailscale",
  extensions: [{ kind: EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, name: "tailscale", value: tailscaleIngressDriver }],
  commands: [{ name: "tailscale", description: "Configure and authenticate a private tailnet gateway for workspaces and agents" }],
  run: runTailscaleCommand,
  workspaceLifecycle: { started: attachTailnet, removing: detachTailnet },
  guest: {
    description: "Host-owned Tailscale gateway provides IPv4 tailnet routing and DNS to the workspace and its inner containers without sharing VPN credentials",
    async inspect(workspace, context) {
      if (!["container", "container-kvm"].includes(workspace.runtime)) return { state: "unconfigured", message: `Tailscale gateway routing is unavailable for runtime '${workspace.runtime}'` };
      const state = await readGatewayState(context.stateRoot);
      if (!state) return { state: "unconfigured", message: "On the host: dim tailscale configure, then dim tailscale up" };
      const gateway = await inspectGateway(context.runner, state);
      if (!gateway || object(gateway.info.State).Running !== true) return { state: "unconfigured", message: "Start the gateway on the host with dim tailscale up" };
      const status = await gatewayStatus(context.runner, state);
      return status.BackendState === "Running" ? { state: "ready", message: "IPv4 tailnet routing and MagicDNS are managed by the host gateway" }
        : { state: "unconfigured", message: "Authenticate the gateway on the host with dim tailscale up" };
    }
  }
};
export { tailscaleIngressDriver } from "./ingress.js";
