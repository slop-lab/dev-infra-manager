import { UserError, type CommandRunner } from "@slop-lab/dim-host-core";
import { gatewayLabels, gatewayNames, type GatewayState } from "./state.js";
// Every restart closes forwarding before the VPN daemon can restore its routes.
// Guest bridges may still be attached when Docker restarts the gateway.
const gatewayCommand = "set -eu; iptables-nft -P FORWARD DROP; ip6tables-nft -P FORWARD DROP; exec tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --tun=tailscale0 --port=41641";
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("invalid Docker gateway response");
  return value as Record<string, unknown>;
}
export async function docker(runner: CommandRunner, args: string[]): Promise<string> {
  const result = await runner.run("docker", args, { signal: AbortSignal.timeout(30_000) });
  if (result.exitCode !== 0) throw new UserError(`Tailscale Docker ${args[0] ?? "operation"} failed: ${result.stderr.trim().slice(0, 1024)}`);
  return result.stdout.trim();
}
export async function inspectResource(runner: CommandRunner, state: GatewayState, kind: "container" | "network" | "volume", name: string, resource: "gateway" | "network" | "auth") {
  const listed = await docker(runner, [kind, "ls", ...(kind === "container" ? ["--all", "--no-trunc"] : []), "--format", "{{json .}}"]);
  if (!listed.split("\n").filter(Boolean).some((line) => { const row = object(JSON.parse(line)); return row.Name === name || row.Names === name; })) return undefined;
  const rows: unknown = JSON.parse(await docker(runner, [kind, "inspect", name]));
  if (!Array.isArray(rows) || rows.length !== 1) throw new UserError("invalid gateway resource inspection");
  const info = object(rows[0]), labels = object(kind === "container" ? object(info.Config).Labels : info.Labels);
  if (Object.entries(gatewayLabels(state, resource)).some(([key, value]) => labels[key] !== value)) throw new UserError(`foreign Tailscale ${kind}: ${name}`);
  return info;
}
export async function inspectGateway(runner: CommandRunner, state: GatewayState): Promise<{ id: string; info: Record<string, unknown> } | undefined> {
  const names = gatewayNames(state), info = await inspectResource(runner, state, "container", names.container, "gateway");
  if (!info) return undefined;
  const host = object(info.HostConfig), config = object(info.Config);
  const mounts = info.Mounts;
  const same = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);
  if (typeof info.Id !== "string" || !/^[0-9a-f]{64}$/.test(info.Id) || config.Image !== state.image || host.Privileged !== false || host.NetworkMode !== names.network
    || !same(config.Entrypoint, ["/bin/sh"]) || !same(config.Cmd, ["-ec", gatewayCommand])
    || !same(host.CapDrop, ["ALL"]) || !same(host.CapAdd, ["CAP_NET_ADMIN", "CAP_NET_RAW"])
    || !Array.isArray(host.Devices) || host.Devices.length !== 1 || !same(host.Devices[0], { PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" })
    || !same(host.SecurityOpt, ["no-new-privileges"]) || object(host.Sysctls)["net.ipv4.ip_forward"] !== "1"
    || !same(host.Tmpfs, { "/tmp": "rw,nosuid,nodev", "/var/run": "rw,nosuid,nodev" })
    || host.ReadonlyRootfs !== true || !Array.isArray(mounts) || mounts.length !== 1 || object(mounts[0]).Type !== "volume"
    || object(mounts[0]).Name !== names.volume || object(mounts[0]).Destination !== "/var/lib/tailscale") throw new UserError("Tailscale gateway runtime ownership changed");
  return { id: info.Id, info };
}
/** Only an explicit operator `up` may replace reviewed gateway code. */
export async function replaceGatewayImage(runner: CommandRunner, state: GatewayState): Promise<void> {
  const current = await inspectResource(runner, state, "container", gatewayNames(state).container, "gateway");
  if (!current || object(current.Config).Image === state.image) return;
  const image = object(current.Config).Image;
  if (typeof image !== "string" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(image)) throw new UserError("cannot replace an unpinned Tailscale gateway");
  const owned = await inspectGateway(runner, { ...state, image });
  if (!owned) throw new UserError("Tailscale gateway disappeared during image replacement");
  // Removing only the verified container leaves the private authentication volume intact.
  await docker(runner, ["rm", "--force", owned.id]);
}
export async function ensureGateway(runner: CommandRunner, state: GatewayState): Promise<string> {
  const names = gatewayNames(state);
  // Pulling new code and login are explicit operator commands; workspace hooks only use reviewed local images.
  await docker(runner, ["image", "inspect", state.image]);
  for (const [kind, name, resource] of [["network", names.network, "network"], ["volume", names.volume, "auth"]] as const) {
    if (!await inspectResource(runner, state, kind, name, resource)) await docker(runner, [kind, "create", ...Object.entries(gatewayLabels(state, resource)).flatMap(([key, value]) => ["--label", `${key}=${value}`]), name]);
  }
  let gateway = await inspectGateway(runner, state);
  if (!gateway) {
    await docker(runner, ["create", "--name", names.container, "--hostname", state.hostname, "--network", names.network,
      "--restart", "unless-stopped", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev", "--tmpfs", "/var/run:rw,nosuid,nodev",
      "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW", "--security-opt", "no-new-privileges",
      "--device", "/dev/net/tun:/dev/net/tun:rwm", "--sysctl", "net.ipv4.ip_forward=1", "--pids-limit", "128", "--memory", "256m", "--cpus", "1",
      "--mount", `type=volume,source=${names.volume},target=/var/lib/tailscale`,
      ...Object.entries(gatewayLabels(state, "gateway")).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--entrypoint", "/bin/sh", state.image, "-ec", gatewayCommand]);
    gateway = await inspectGateway(runner, state);
  }
  if (!gateway) throw new UserError("created Tailscale gateway is missing");
  if (object(gateway.info.State).Running !== true) await docker(runner, ["start", gateway.id]);
  // Default-deny forwarding is installed before a workspace can attach, including after gateway restart.
  await docker(runner, ["exec", gateway.id, "sh", "-ec", "iptables-nft -P FORWARD DROP; ip6tables-nft -P FORWARD DROP"]);
  return gateway.id;
}
export async function gatewayStatus(runner: CommandRunner, state: GatewayState): Promise<Record<string, unknown>> {
  const gateway = await inspectGateway(runner, state);
  if (!gateway) throw new UserError("Tailscale gateway is not running; run dim tailscale up");
  return object(JSON.parse(await docker(runner, ["exec", gateway.id, "tailscale", "status", "--json"])));
}
