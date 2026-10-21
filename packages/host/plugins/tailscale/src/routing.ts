import { Readable } from "node:stream";
import { isIPv4 } from "node:net";
import { acquireLifecycleLock, UserError, type CommandRunner } from "@slop-lab/dim-host-core";
import { workspaceRuntimeResources, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceRuntimeFactoryContext } from "@slop-lab/dim-host-core/plugin-api";
import { gatewayNames, readGatewayState, type GatewayState } from "./state.js";
import { ensureGateway, inspectGateway } from "./gateway.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("invalid tailnet network inspection");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new UserError("invalid tailnet network inspection array"); return value; }
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new UserError("missing tailnet network identity"); return value; }
async function docker(runner: CommandRunner, args: string[], script?: string): Promise<string> {
  const result = await runner.run("docker", args, { signal: AbortSignal.timeout(60_000), ...(script === undefined ? {} : { stdin: Readable.from([script]) }) });
  if (result.exitCode !== 0) throw new UserError(`tailnet ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().slice(0, 1024)}`);
  return result.stdout;
}
async function inspect(runner: CommandRunner, kind: "container" | "network", name: string): Promise<Record<string, unknown>> {
  return object(array(JSON.parse(await docker(runner, [kind, "inspect", name])) as unknown)[0]);
}
function assertWorkspace(info: Record<string, unknown>, record: Pick<WorkspaceRecord, "id">, role: "container" | "network"): void {
  const labels = object(role === "container" ? object(info.Config).Labels : info.Labels);
  if (labels["dim.managed"] !== "true" || labels["dim.workspace-id"] !== record.id || labels["dim.resource"] !== role || labels["dim.workspace-schema"] !== "10") throw new UserError("workspace tailnet resource ownership conflicts");
}
function supported(record: WorkspaceRecord): boolean { return ["container", "container-kvm"].includes(record.runtime); }
function ipv4(value: unknown): string { const result = text(value); if (!isIPv4(result)) throw new UserError("tailnet bridge has no IPv4 address"); return result; }
function cidr(value: unknown): string {
  const result = text(value), parts = result.split("/");
  if (parts.length !== 2 || !isIPv4(parts[0]!) || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]!)) throw new UserError("invalid workspace IPv4 subnet");
  return result;
}
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
interface Bridge { readonly name: string; readonly id: string; readonly address: string; readonly subnet: string; readonly iface: string }
async function connectedBridges(runner: CommandRunner, state: GatewayState, gateway: Record<string, unknown>): Promise<{ control: string; bridges: Bridge[] }> {
  const addresses = array(JSON.parse(await docker(runner, ["exec", text(gateway.Id), "ip", "-j", "-4", "address", "show"])) as unknown).map(object);
  const networks = object(object(gateway.NetworkSettings).Networks), controlName = gatewayNames(state).network;
  const bridges: Bridge[] = []; let control: string | undefined;
  for (const [name, raw] of Object.entries(networks)) {
    const endpoint = object(raw), address = ipv4(endpoint.IPAddress);
    const device = addresses.find((entry) => array(entry.addr_info).some((raw) => object(raw).local === address));
    const iface = text(device?.ifname);
    if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(iface) || ["lo", "tailscale0"].includes(iface)) throw new UserError("invalid gateway bridge interface");
    if (name === controlName) { control = iface; continue; }
    const network = await inspect(runner, "network", name), id = text(network.Id), labels = object(network.Labels);
    const workspaceId = text(labels["dim.workspace-id"]);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(workspaceId) || workspaceRuntimeResources({ id: workspaceId }).network !== name) throw new UserError("foreign network attached to Tailscale gateway");
    assertWorkspace(network, { id: workspaceId }, "network");
    if (endpoint.NetworkID !== id || network.Driver !== "bridge") throw new UserError("gateway workspace network identity changed");
    const subnet = array(object(network.IPAM).Config).map(object).find((entry) => typeof entry.Subnet === "string" && !entry.Subnet.includes(":"))?.Subnet;
    bridges.push({ name, id, address, iface, subnet: cidr(subnet) });
  }
  if (!control) throw new UserError("gateway control network is missing");
  return { control, bridges };
}
function firewall(control: string, bridges: readonly Bridge[]): string {
  const rules = ["set -eu", "iptables-nft -w -P FORWARD DROP", "iptables-nft -w -P INPUT DROP", "ip6tables-nft -w -P FORWARD DROP", "ip6tables-nft -w -P INPUT DROP"];
  for (const [table, chain, parent] of [["filter", "DIM_TAILNET_IN", "INPUT"], ["filter", "DIM_TAILNET_FWD", "FORWARD"], ["nat", "DIM_TAILNET_NAT", "POSTROUTING"]]) {
    rules.push(`iptables-nft -w -t ${table} -N ${chain} 2>/dev/null || iptables-nft -w -t ${table} -S ${chain} >/dev/null`, `iptables-nft -w -t ${table} -C ${parent} -j ${chain} 2>/dev/null || iptables-nft -w -t ${table} -I ${parent} 1 -j ${chain}`, `iptables-nft -w -t ${table} -F ${chain}`);
  }
  rules.push("iptables-nft -w -A DIM_TAILNET_IN -i lo -j ACCEPT", "iptables-nft -w -A DIM_TAILNET_IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT", `iptables-nft -w -A DIM_TAILNET_IN -i ${shell(control)} -p udp --dport 41641 -j ACCEPT`, "ip6tables-nft -w -C INPUT -i lo -j ACCEPT 2>/dev/null || ip6tables-nft -w -I INPUT 1 -i lo -j ACCEPT");
  for (const bridge of bridges) {
    const iface = shell(bridge.iface), subnet = shell(bridge.subnet);
    for (const protocol of ["udp", "tcp"]) {
      rules.push(`iptables-nft -w -A DIM_TAILNET_IN -i ${iface} -s ${subnet} -p ${protocol} --dport 53 -j ACCEPT`, `iptables-nft -w -A DIM_TAILNET_FWD -i ${iface} -s ${subnet} -o tailscale0 -d 100.100.100.100 -p ${protocol} --dport 53 -j ACCEPT`);
    }
    rules.push(`iptables-nft -w -A DIM_TAILNET_FWD -i ${iface} -d 100.100.100.100 -j DROP`, `iptables-nft -w -A DIM_TAILNET_FWD -i ${iface} -s ${subnet} -o tailscale0 -d 100.64.0.0/10 -j ACCEPT`, `iptables-nft -w -A DIM_TAILNET_FWD -i tailscale0 -o ${iface} -d ${subnet} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`, `iptables-nft -w -t nat -A DIM_TAILNET_NAT -s ${subnet} -o tailscale0 -d 100.64.0.0/10 -j MASQUERADE`);
  }
  rules.push("iptables-nft -w -A DIM_TAILNET_IN -j DROP", "iptables-nft -w -A DIM_TAILNET_FWD -j DROP");
  return `${rules.join("\n")}\n`;
}
const workspaceDns = `
const fs = require('node:fs');
const dns = '100.100.100.100', suffix = process.argv[2];
if (suffix && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(suffix)) throw new Error('invalid tailnet DNS suffix');
const resolver = fs.readFileSync('/etc/resolv.conf', 'utf8');
const previousSearch = resolver.split('\\n').filter((line) => /^search\\s/.test(line)).flatMap((line) => line.trim().split(/\\s+/).slice(1));
const searches = [...new Set([...(suffix ? [suffix] : []), ...previousSearch])];
const updated = resolver.replace(/^(?:nameserver|search)[^\\n]*(?:\\n|$)/gm, '').trimEnd();
const resolved = 'nameserver ' + dns + '\\n' + (searches.length ? 'search ' + searches.join(' ') + '\\n' : '') + (updated ? updated + '\\n' : '');
if (resolver !== resolved) fs.writeFileSync('/etc/resolv.conf', resolved);
// New nested containers inherit this workspace resolver. Never restart their Docker daemon or running agents.
`;

export async function attachTailnet(record: WorkspaceRecord, context: WorkspaceRuntimeFactoryContext): Promise<void> {
  if (!supported(record)) return;
  const state = await readGatewayState(context.stateRoot); if (!state) return;
  const release = await acquireLifecycleLock({ root: context.stateRoot, name: "tailscale-routing", description: "Tailscale workspace routing" });
  try {
    const names = workspaceRuntimeResources(record), network = await inspect(context.runner, "network", names.network), workspace = await inspect(context.runner, "container", names.container);
    assertWorkspace(network, record, "network"); assertWorkspace(workspace, record, "container");
    if (Object.keys(object(object(workspace.NetworkSettings).Networks)).join() !== names.network) throw new UserError("workspace must retain its single private bridge");
    const gatewayId = await ensureGateway(context.runner, state);
    const status = object(JSON.parse(await docker(context.runner, ["exec", gatewayId, "tailscale", "status", "--json"])) as unknown);
    if (status.BackendState !== "Running") throw new UserError("Tailscale gateway is not logged in; run dim tailscale up");
    let gateway = await inspectGateway(context.runner, state);
    if (!gateway) throw new UserError("Tailscale gateway disappeared before attachment");
    const before = await connectedBridges(context.runner, state, gateway.info);
    await docker(context.runner, ["exec", "-i", gatewayId, "sh", "-s"], firewall(before.control, before.bridges));
    if (!before.bridges.some(({ name }) => name === names.network)) await docker(context.runner, ["network", "connect", text(network.Id), gatewayId]);
    gateway = await inspectGateway(context.runner, state);
    if (!gateway) throw new UserError("Tailscale gateway disappeared during attachment");
    const after = await connectedBridges(context.runner, state, gateway.info), selected = after.bridges.find(({ name }) => name === names.network);
    if (!selected) throw new UserError("gateway failed to attach the owned workspace bridge");
    await docker(context.runner, ["exec", "-i", gatewayId, "sh", "-s"], firewall(after.control, after.bridges));
    await docker(context.runner, ["exec", "--user", "root", names.container, "ip", "route", "replace", "100.64.0.0/10", "via", selected.address]);
    await docker(context.runner, ["exec", "--user", "root", "-i", names.container, "node", "-", typeof status.MagicDNSSuffix === "string" ? status.MagicDNSSuffix : ""], workspaceDns);
  } finally { await release(); }
}
export async function detachTailnet(record: WorkspaceRecord, options: { readonly keepData: boolean }, context: WorkspaceRuntimeFactoryContext): Promise<void> {
  if (options.keepData) return;
  if (!supported(record)) return;
  const state = await readGatewayState(context.stateRoot); if (!state) return;
  const release = await acquireLifecycleLock({ root: context.stateRoot, name: "tailscale-routing", description: "Tailscale workspace routing cleanup" });
  try {
    const gateway = await inspectGateway(context.cleanupRunner, state); if (!gateway) return;
    const names = workspaceRuntimeResources(record), networks = object(object(gateway.info.NetworkSettings).Networks);
    if (!Object.hasOwn(networks, names.network)) return;
    const network = await inspect(context.cleanupRunner, "network", names.network); assertWorkspace(network, record, "network");
    if (object(networks[names.network]).NetworkID !== network.Id) throw new UserError("gateway workspace network identity changed before cleanup");
    await docker(context.cleanupRunner, ["network", "disconnect", text(network.Id), gateway.id]);
    const current = await inspectGateway(context.cleanupRunner, state);
    if (current && object(current.info.State).Running === true) { const remaining = await connectedBridges(context.cleanupRunner, state, current.info); await docker(context.cleanupRunner, ["exec", "-i", current.id, "sh", "-s"], firewall(remaining.control, remaining.bridges)); }
  } finally { await release(); }
}
