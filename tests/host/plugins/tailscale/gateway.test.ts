import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RunOptions, StreamingCommandRunner } from "@slop-lab/dim-host-core";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { runTailscaleCommand } from "../../../../packages/host/plugins/tailscale/src/index.js";
import { ensureGateway, inspectGateway, replaceGatewayImage } from "../../../../packages/host/plugins/tailscale/src/gateway.js";
import { configureGateway, gatewayDirectory, gatewayLabels, gatewayNames, readGatewayState, type GatewayState } from "../../../../packages/host/plugins/tailscale/src/state.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(path.join(tmpdir(), "dim-tailnet-gateway-")); roots.push(value); return value; }

class GatewayRunner implements StreamingCommandRunner {
  info: Record<string, unknown> | undefined;
  readonly calls: string[][] = [];
  readonly streaming: { args: string[]; input: string }[] = [];
  constructor(readonly state: GatewayState) {}
  async run(command: string, args: string[]) {
    this.calls.push(args);
    const names = gatewayNames(this.state);
    let stdout = "";
    if (args[1] === "ls") {
      const name = args[0] === "network" ? names.network : args[0] === "volume" ? names.volume : this.info ? names.container : undefined;
      if (name) stdout = JSON.stringify({ Name: name, Names: name });
    } else if (args[1] === "inspect" && args[0] !== "image") {
      const info = args[0] === "container" ? this.info : { Labels: gatewayLabels(this.state, args[0] === "network" ? "network" : "auth") };
      stdout = JSON.stringify([info]);
    } else if (args[0] === "create") {
      const value = (flag: string) => args[args.indexOf(flag) + 1];
      this.info = { Id: "a".repeat(64), Config: { Image: this.state.image, Labels: gatewayLabels(this.state, "gateway"),
        Entrypoint: [value("--entrypoint")], Cmd: args.slice(args.indexOf(this.state.image) + 1) },
      HostConfig: { Privileged: false, NetworkMode: names.network, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: ["CAP_NET_ADMIN", "CAP_NET_RAW"],
        Devices: [{ PathOnHost: "/dev/net/tun", PathInContainer: "/dev/net/tun", CgroupPermissions: "rwm" }], SecurityOpt: ["no-new-privileges"],
        Sysctls: { "net.ipv4.ip_forward": "1" }, Tmpfs: { "/tmp": "rw,nosuid,nodev", "/var/run": "rw,nosuid,nodev" } },
      Mounts: [{ Type: "volume", Name: names.volume, Destination: "/var/lib/tailscale" }], State: { Running: false } };
    } else if (args[0] === "start" && this.info) this.info.State = { Running: true };
    return { command, args, stdout, stderr: "", exitCode: 0 };
  }
  async runStreaming(_command: string, args: string[], options?: RunOptions) {
    let input = "";
    if (options?.stdin) for await (const bytes of options.stdin) input += String(bytes);
    this.streaming.push({ args, input }); return 0;
  }
}
function context(stateRoot: string, runner: GatewayRunner): Pick<WorkspaceHostPluginContext, "runner" | "stateRoot" | "signal"> {
  return { stateRoot, runner, signal: AbortSignal.timeout(10_000) };
}

it("replaces only the verified gateway container when the operator selects a new image", async () => {
  const state = await configureGateway(await root()), runner = new GatewayRunner(state);
  await ensureGateway(runner, state); runner.calls.length = 0;
  await replaceGatewayImage(runner, { ...state, image: state.image.replace(/sha256:[0-9a-f]{64}$/, `sha256:${"b".repeat(64)}`) });
  expect(runner.calls.filter((args) => args[0] === "rm")).toEqual([["rm", "--force", "a".repeat(64)]]);
  expect(runner.calls.some((args) => args[0] === "volume" || args[0] === "network")).toBe(false);
});

it("closes forwarding before the daemon starts, including Docker restart of the saved command", async () => {
  const directory = await root(), state = await configureGateway(directory), runner = new GatewayRunner(state);
  await ensureGateway(runner, state);
  const config = runner.info!.Config as { Entrypoint: string[]; Cmd: string[] }, log = path.join(directory, "firewall");
  for (const name of ["iptables-nft", "ip6tables-nft"]) {
    const file = path.join(directory, name);
    await writeFile(file, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$DIM_FIREWALL_LOG"\n`); await chmod(file, 0o700);
  }
  const daemon = path.join(directory, "tailscaled");
  await writeFile(daemon, `#!/bin/sh\ngrep -qx 'iptables-nft -P FORWARD DROP' "$DIM_FIREWALL_LOG" && grep -qx 'ip6tables-nft -P FORWARD DROP' "$DIM_FIREWALL_LOG"\n`); await chmod(daemon, 0o700);
  const result = spawnSync(config.Entrypoint[0]!, config.Cmd, { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DIM_FIREWALL_LOG: log }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(runner.calls.findIndex((args) => args[0] === "start")).toBeGreaterThan(runner.calls.findIndex((args) => args[0] === "create"));
});

it.each(["owner", "image", "network", "privilege", "capability", "mount", "command"])("rejects gateway %s tampering before restart", async (change) => {
  const directory = await root(), state = await configureGateway(directory), runner = new GatewayRunner(state);
  await ensureGateway(runner, state); runner.calls.length = 0;
  const info = runner.info!, config = info.Config as Record<string, unknown>, host = info.HostConfig as Record<string, unknown>;
  if (change === "owner") config.Labels = { ...gatewayLabels(state, "gateway"), "dim.tailscale-id": "foreign" };
  if (change === "image") config.Image = "foreign/image:latest";
  if (change === "network") host.NetworkMode = "host";
  if (change === "privilege") host.Privileged = true;
  if (change === "capability") host.CapAdd = ["CAP_SYS_ADMIN"];
  if (change === "mount") info.Mounts = [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/lib/tailscale" }];
  if (change === "command") config.Cmd = ["-ec", "tailscaled"];
  await expect(inspectGateway(runner, state)).rejects.toThrow(/foreign|ownership changed/);
  await expect(ensureGateway(runner, state)).rejects.toThrow(/foreign|ownership changed/);
  expect(runner.calls.some((args) => ["start", "exec", "create"].includes(args[0]!))).toBe(false);
});

it("keeps login keys out of process arguments, using a private stdin file", async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const directory = await root(), state = await configureGateway(directory), runner = new GatewayRunner(state);
  const file = path.join(directory, "key"), secret = "tskey-auth-private-test";
  await writeFile(file, secret, { mode: 0o600 });
  await runTailscaleCommand(["tailscale", "up", "--auth-key-file", file], context(directory, runner));
  expect(runner.streaming.map(({ args }) => args.join(" ")).join("\n")).not.toContain(secret);
  expect(runner.calls.flat().join(" ")).not.toContain(secret);
  const login = runner.streaming.find(({ input }) => input === secret);
  expect(login).toBeDefined();
  expect(login!.args.join(" ")).toContain("--auth-key=file:");
  expect(login!.args.join(" ")).toContain("umask 077");
  expect(login!.args.join(" ")).toContain("trap 'rm -f");
});

it("rejects public or linked key files without contacting Docker", async () => {
  const directory = await root(), state = await configureGateway(directory), runner = new GatewayRunner(state), file = path.join(directory, "key");
  await writeFile(file, "tskey-auth-private-test", { mode: 0o644 });
  await expect(runTailscaleCommand(["tailscale", "up", "--auth-key-file", file], context(directory, runner))).rejects.toThrow(/private/);
  await chmod(file, 0o600); await symlink(file, `${file}-link`);
  await expect(runTailscaleCommand(["tailscale", "up", "--auth-key-file", `${file}-link`], context(directory, runner))).rejects.toThrow(/private/);
  expect(runner.calls).toEqual([]); expect(runner.streaming).toEqual([]);
});

it("preserves a private gateway identity and rejects publicly readable saved state", async () => {
  const directory = await root(), first = await configureGateway(directory), second = await configureGateway(directory, { hostname: "changed" });
  expect(second.id).toBe(first.id);
  const saved = path.join(gatewayDirectory(directory), "gateway.json");
  expect((await lstat(gatewayDirectory(directory))).mode & 0o777).toBe(0o700);
  expect((await lstat(saved)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(saved, "utf8")).id).toBe(first.id);
  await chmod(saved, 0o644); await expect(readGatewayState(directory)).rejects.toThrow(/private/);
});
