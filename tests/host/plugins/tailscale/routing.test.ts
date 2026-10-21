import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { RunOptions, StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { workspaceRuntimeResources } from "@slop-lab/dim-host-core/workspace";
import { configureGateway, gatewayNames } from "../../../../packages/host/plugins/tailscale/src/state.js";
import { attachTailnet, detachTailnet } from "../../../../packages/host/plugins/tailscale/src/routing.js";
import * as gateway from "../../../../packages/host/plugins/tailscale/src/gateway.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
vi.mock("../../../../packages/host/plugins/tailscale/src/gateway.js", () => ({ ensureGateway: vi.fn(), inspectGateway: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(configure = true) {
  const stateRoot = await mkdtemp(join(tmpdir(), "dim-tailnet-routing-")); roots.push(stateRoot);
  const state = configure ? await configureGateway(stateRoot) : undefined;
  const record = workspaceRecord("tailnet"), names = workspaceRuntimeResources(record);
  let connected = false, loggedIn = true, foreign = false;
  const calls: Array<{ args: string[]; script?: string }> = [];
  const labels = (resource: string) => ({ "dim.managed": "true", "dim.workspace-id": record.id, "dim.resource": resource, "dim.workspace-schema": "10" });
  const network = () => ({ Id: "workspace-network-id", Driver: "bridge", Labels: foreign ? {} : labels("network"), IPAM: { Config: [{ Subnet: "172.30.0.0/24" }] } });
  const gatewayInfo = () => ({ Id: "gateway-id", State: { Running: true }, NetworkSettings: { Networks: { [gatewayNames(state!).network]: { IPAddress: "172.29.0.2", NetworkID: "control-network-id" }, ...(connected ? { [names.network]: { IPAddress: "172.30.0.3", NetworkID: "workspace-network-id" } } : {}) } } });
  vi.mocked(gateway.ensureGateway).mockResolvedValue("gateway-id");
  vi.mocked(gateway.inspectGateway).mockImplementation(async () => ({ id: "gateway-id", info: gatewayInfo() }));
  const runner: StreamingCommandRunner = {
    async run(_command: string, args: string[], options?: RunOptions) {
      let script: string | undefined;
      if (options?.stdin) { script = ""; for await (const part of options.stdin) script += String(part); }
      calls.push({ args, ...(script === undefined ? {} : { script }) });
      let value: unknown;
      if (args[0] === "network" && args[1] === "inspect") value = [network()];
      else if (args[0] === "container" && args[1] === "inspect") value = [{ Config: { Labels: labels("container") }, NetworkSettings: { Networks: { [names.network]: {} } } }];
      else if (args.includes("status")) value = { BackendState: loggedIn ? "Running" : "NeedsLogin", MagicDNSSuffix: "test-tailnet.ts.net" };
      else if (args.includes("address")) value = [{ ifname: "eth0", addr_info: [{ local: "172.29.0.2" }] }, ...(connected ? [{ ifname: "eth1", addr_info: [{ local: "172.30.0.3" }] }] : [])];
      else if (args[0] === "network" && args[1] === "connect") connected = true;
      else if (args[0] === "network" && args[1] === "disconnect") connected = false;
      return { command: "docker", args, stdout: value === undefined ? "" : JSON.stringify(value), stderr: "", exitCode: 0 };
    }, async runStreaming() { return 0; }
  };
  return { record, names, calls, context: { runner, cleanupRunner: runner, stateRoot }, loggedIn(value: boolean) { loggedIn = value; }, foreign(value: boolean) { foreign = value; } };
}
it("does nothing until configured and refuses foreign ownership or login-required gateways before changing guest networking", async () => {
  const unset = await fixture(false); await attachTailnet(unset.record, unset.context); expect(unset.calls).toEqual([]);
  const f = await fixture();
  await attachTailnet({ ...f.record, runtime: "vm" }, f.context);
  await detachTailnet({ ...f.record, runtime: "vm" }, { keepData: false }, f.context);
  expect(f.calls).toEqual([]); expect(gateway.ensureGateway).not.toHaveBeenCalled();
  f.foreign(true);
  await expect(attachTailnet(f.record, f.context)).rejects.toThrow("ownership conflicts"); expect(gateway.ensureGateway).not.toHaveBeenCalled();
  f.foreign(false); f.loggedIn(false); await expect(attachTailnet(f.record, f.context)).rejects.toThrow("not logged in");
  expect(f.calls.some(({ args }) => args.includes("connect") || args.includes("route") || args.includes("node"))).toBe(false);
});
it("attaches only the gateway, installs constrained forwarding before guest routes, and disconnects only on final discard", async () => {
  const f = await fixture(); await attachTailnet(f.record, f.context);
  const connects = f.calls.filter(({ args }) => args[0] === "network" && args[1] === "connect");
  expect(connects.map(({ args }) => args.slice(2))).toEqual([["workspace-network-id", "gateway-id"]]);
  const connectIndex = f.calls.findIndex(({ args }) => args[1] === "connect"), routeIndex = f.calls.findIndex(({ args }) => args.includes("route"));
  expect(f.calls.slice(0, connectIndex).some(({ script }) => script?.includes("iptables-nft -w -P FORWARD DROP"))).toBe(true);
  expect(routeIndex).toBeGreaterThan(connectIndex);
  expect(f.calls[routeIndex]?.args).toEqual(["exec", "--user", "root", f.names.container, "ip", "route", "replace", "100.64.0.0/10", "via", "172.30.0.3"]);
  const policy = f.calls.filter(({ script }) => script?.includes("DIM_TAILNET_FWD")).at(-1)?.script ?? "";
  expect(policy).toContain("-o tailscale0 -d 100.64.0.0/10 -j ACCEPT");
  expect(policy).toContain("-d 100.100.100.100 -j DROP"); expect(policy).toContain("--ctstate ESTABLISHED,RELATED"); expect(policy).toContain("-A DIM_TAILNET_FWD -j DROP");
  await detachTailnet(f.record, { keepData: true }, f.context); expect(f.calls.some(({ args }) => args[1] === "disconnect")).toBe(false);
  await detachTailnet(f.record, { keepData: false }, f.context);
  expect(f.calls.filter(({ args }) => args[1] === "disconnect").map(({ args }) => args.slice(2))).toEqual([["workspace-network-id", "gateway-id"]]);
});
it("updates only the workspace resolver and leaves Docker configuration and running agents untouched", async () => {
  const f = await fixture(); await attachTailnet(f.record, f.context);
  const script = f.calls.find(({ args }) => args.includes("node"))?.script; expect(script).toBeTruthy();
  const files = new Map<string, string>([["/etc/docker/daemon.json", JSON.stringify({ "registry-mirrors": ["http://cache/"], "insecure-registries": ["cache"] })], ["/etc/resolv.conf", "nameserver 127.0.0.11\nsearch example.test\noptions ndots:0\n"], ["/var/run/docker.pid", "23\n"], ["/proc/23/comm", "dockerd\n"], ["/proc/23/cmdline", "dockerd\0--data-root=/var/lib/docker\0"]]);
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const writes: string[] = [];
  const fs = { readFileSync(path: string) { const value = files.get(path); if (value === undefined) throw missing(); return value; }, writeFileSync(path: string, value: string) { writes.push(path); files.set(path, value); } };
  const context = { require(name: string) { if (name !== "node:fs") throw new Error(`unexpected runtime dependency ${name}`); return fs; }, process: { argv: ["node", "-", "test-tailnet.ts.net"] } };
  runInNewContext(script!, context);
  expect(JSON.parse(files.get("/etc/docker/daemon.json")!)).toEqual({ "registry-mirrors": ["http://cache/"], "insecure-registries": ["cache"] });
  expect(files.get("/etc/resolv.conf")).toBe("nameserver 100.100.100.100\nsearch test-tailnet.ts.net example.test\noptions ndots:0\n");
  runInNewContext(script!, { ...context }); expect(writes).toEqual(["/etc/resolv.conf"]);

});
