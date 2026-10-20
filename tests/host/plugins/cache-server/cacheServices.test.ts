import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { CommandResult, StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { cacheServiceNames, ensureCacheServices, type CacheServiceDefinition } from "../../../../packages/host/plugins/cache-server/src/cache-services.js";
import { MirrorState } from "../../../../packages/host/plugins/cache-server/src/cacheState.js";
import { dockerService } from "../../../../packages/host/plugins/cache-server/src/services/docker.js";
import { aptService } from "../../../../packages/host/plugins/cache-server/src/services/apt.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const image = `example/cache@sha256:${"a".repeat(64)}`;
const definition: CacheServiceDefinition = { name: "test", image, port: 4873, dataTarget: "/data", environment: { CACHE: "enabled" },
  entrypoint: ["/bin/cache"], command: ["--serve"], configFiles: [{ name: "config.yaml", contents: "reviewed: true\n", target: "/etc/cache.yaml" }] };
async function fixture() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-caches-")); roots.push(stateRoot);
  return { stateRoot, namespace: `test-${randomUUID().slice(0, 8)}` };
}

class Docker implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  readonly resources = { network: new Map<string, Record<string, unknown>>(), volume: new Map<string, Record<string, unknown>>(), container: new Map<string, Record<string, unknown>>() };
  inspectFailure: string | undefined;
  private nextPort = 40_001;
  constructor() {
    this.resources.network.set("bridge", { Id: "docker-bridge", Driver: "bridge", Internal: false, IPAM: { Config: [{ Gateway: "172.17.0.1", Subnet: "172.17.0.0/16" }] } });
  }
  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    const result = (stdout = "", stderr = "", exitCode = 0): CommandResult => ({ command, args, stdout, stderr, exitCode });
    const type = args[0];
    if ((type === "network" || type === "volume" || type === "container") && args[1] === "inspect") {
      if (this.inspectFailure) return result("", this.inspectFailure, 1);
      const name = args[2] ?? "";
      const found = this.resources[type].get(name) ?? [...this.resources[type].values()].find((entry) => entry.Id === name);
      return found ? result(JSON.stringify(found)) : result("", type === "network" ? `Error response from daemon: network ${name} not found`
        : type === "volume" ? `Error response from daemon: get ${name}: no such volume` : `Error response from daemon: No such container: ${name}`, 1);
    }
    const values = (flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? ""] : []);
    const labels = Object.fromEntries(values("--label").map((label) => { const split = label.indexOf("="); return [label.slice(0, split), label.slice(split + 1)]; }));
    if ((type === "network" || type === "volume") && args[1] === "create") {
      const name = args.at(-1) ?? "";
      this.resources[type].set(name, { Id: randomUUID(), Labels: labels, Driver: type === "network" ? "bridge" : "local", Internal: false, Options: null });
      return result();
    }
    if (type === "run") {
      const name = values("--name")[0] ?? "", network = values("--network")[0] ?? "";
      const imageIndex = args.findIndex((arg) => arg.includes("@sha256:"));
      const entrypoint = values("--entrypoint");
      const [publicationHost, , port] = (values("--publish")[0] ?? "").split(":");
      const allocated = String(this.nextPort++);
      this.resources.container.set(name, { Id: randomUUID(), Config: { Image: args[imageIndex], Labels: labels, Env: values("--env"), Entrypoint: entrypoint, Cmd: args.slice(imageIndex + 1) },
        State: { Running: true }, HostConfig: { Privileged: false, PortBindings: { [port ?? ""]: [{ HostIp: publicationHost, HostPort: "" }] }, NetworkMode: network, RestartPolicy: { Name: "unless-stopped" } },
        Mounts: values("--mount").map((mount) => { const fields = Object.fromEntries(mount.split(",").map((item) => item.includes("=") ? item.split("=") : [item, true]));
          return { Type: fields.type, Name: fields.source, Source: fields.source, Destination: fields.target, RW: !fields.readonly }; }),
        NetworkSettings: { Ports: { [port ?? ""]: [{ HostIp: publicationHost, HostPort: allocated }] }, Networks: { [network]: { NetworkID: this.resources.network.get(network)?.Id, IPAddress: "172.24.0.2" } } } });
      return result();
    }
    if (type === "container" && args[1] === "rm") {
      const existing = [...this.resources.container].find(([, entry]) => entry.Id === args.at(-1));
      if (existing) this.resources.container.delete(existing[0]);
      return result();
    }
    if (type === "start") {
      const found = [...this.resources.container.values()].find((entry) => entry.Id === args[1]);
      if (found) {
        found.State = { Running: true };
        const bindings = record(record(found.HostConfig).PortBindings);
        record(found.NetworkSettings).Ports = Object.fromEntries(Object.entries(bindings).map(([key, entries]) => {
          if (!Array.isArray(entries)) throw new Error("invalid fixture bindings");
          return [key, [{ HostIp: record(entries[0]).HostIp, HostPort: String(this.nextPort++) }]];
        }));
      }
      return result();
    }
    throw new Error(`unexpected Docker command ${args.join(" ")}`);
  }
  async runStreaming(): Promise<number> { throw new Error("unexpected streaming Docker command"); }
}

it("reconciles selected services and preserves independent volumes across configuration/image updates", async () => {
  const options = await fixture(), runner = new Docker();
  const names = cacheServiceNames("test", options.namespace);
  expect(await ensureCacheServices(runner, options, [definition])).toEqual({ test: { host: "172.17.0.1", port: 40001 } });
  expect(runner.calls.find((call) => call[1] === "run")).toContain("172.17.0.1::4873/tcp");
  const first = runner.resources.container.get(names.container)?.Id, data = runner.resources.volume.get(names.volume)?.Id;
  await ensureCacheServices(runner, options, [definition]);
  expect(runner.resources.container.get(names.container)?.Id).toBe(first);
  const updated = { ...definition, image: image.replace("a".repeat(64), "b".repeat(64)), configFiles: [{ name: "config.yaml", target: "/etc/cache.yaml", contents: "reviewed: changed\n" }] };
  await ensureCacheServices(runner, options, [updated]);
  expect(runner.resources.container.get(names.container)?.Id).not.toBe(first);
  expect(runner.resources.volume.get(names.volume)?.Id).toBe(data);
  expect(await readFile(path.join(options.stateRoot, "services", options.namespace, "test/config.yaml"), "utf8")).toBe("reviewed: changed\n");
  expect(runner.calls.filter((call) => call[1] === "volume" && call[2] === "create")).toHaveLength(1);
  expect(runner.calls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
});

it("adds selected protocols without changing previously persisted ownership or provisioning unselected caches", async () => {
  const options = await fixture(), runner = new Docker(), state = new MirrorState(options.stateRoot, options.namespace);
  await ensureCacheServices(runner, options, [dockerService.definition(image)]);
  const first = await state.readHostMirrorOwnership();
  await ensureCacheServices(runner, options, [dockerService.definition(image), aptService.definition(image)]);
  const second = await state.readHostMirrorOwnership();
  expect(second?.serviceId).toBe(first?.serviceId);
  expect(second?.resourceIds["cache:docker"]).toBe(first?.resourceIds["cache:docker"]);
  expect([...runner.resources.container.keys()]).toEqual([cacheServiceNames("docker", options.namespace).container, cacheServiceNames("apt", options.namespace).container]);
  const calls = runner.calls.length;
  expect(await ensureCacheServices(runner, options, [])).toEqual({});
  expect(runner.calls).toHaveLength(calls);
});

it("concurrent reconcilers create one shared network, volume and service", async () => {
  const options = await fixture(), runner = new Docker();
  await Promise.all(Array.from({ length: 6 }, () => ensureCacheServices(runner, options, [definition])));
  expect(runner.calls.filter((call) => call[1] === "network" && call[2] === "create")).toHaveLength(1);
  expect(runner.calls.filter((call) => call[1] === "volume" && call[2] === "create")).toHaveLength(1);
  expect(runner.calls.filter((call) => call[1] === "run")).toHaveLength(1);
});

it.each(["network", "volume", "container"] as const)("refuses foreign %s resources without replacing or adopting them", async (type) => {
  const options = await fixture(), runner = new Docker(), names = cacheServiceNames("test", options.namespace);
  await ensureCacheServices(runner, options, [definition]);
  const resource = runner.resources[type].get(type === "network" ? names.network : type === "volume" ? names.volume : names.container);
  if (!resource) throw new Error("missing fixture resource");
  if (type === "container") resource.Config = { ...record(resource.Config), Labels: {} }; else resource.Labels = {};
  runner.calls.length = 0;
  await expect(ensureCacheServices(runner, options, [definition])).rejects.toThrow(/not managed by this host cache/);
  expect(runner.calls.every((call) => call[2] === "inspect")).toBe(true);
});

it("denies unexpected mounts, network reuse, exposed ports and privileged runtime configurations", async () => {
  for (const change of [
    (container: Record<string, unknown>) => { record(container.HostConfig).Privileged = true; },
    (container: Record<string, unknown>) => { record(container.HostConfig).PortBindings = { "4873/tcp": [{ HostIp: "0.0.0.0", HostPort: "4873" }] }; },
    (container: Record<string, unknown>) => { record(container.NetworkSettings).Ports = { "4873/tcp": [{ HostIp: "192.168.1.2", HostPort: "40001" }] }; },
    (container: Record<string, unknown>) => { container.Mounts = [{ Type: "bind", Source: "/var/run/docker.sock", Destination: "/data", RW: true }]; },
    (container: Record<string, unknown>) => { record(record(container.NetworkSettings).Networks)["foreign"] = {}; }
  ]) {
    const options = await fixture(), runner = new Docker();
    await ensureCacheServices(runner, options, [definition]);
    const container = runner.resources.container.get(cacheServiceNames("test", options.namespace).container);
    if (!container) throw new Error("missing fixture container");
    change(container); runner.calls.length = 0;
    await expect(ensureCacheServices(runner, options, [definition])).rejects.toThrow(/unexpected runtime configuration/);
    expect(runner.calls.some((call) => call[2] === "rm" || call[1] === "run")).toBe(false);
  }
});

it("propagates daemon failures without treating them as missing resources", async () => {
  const options = await fixture(), runner = new Docker(); runner.inspectFailure = "permission denied connecting to Docker daemon";
  await expect(ensureCacheServices(runner, options, [definition])).rejects.toThrow(/permission denied/);
  expect(runner.calls).toHaveLength(1);
});

it("starts stopped owned services by immutable ID and rejects stale network identities", async () => {
  const options = await fixture(), runner = new Docker(), names = cacheServiceNames("test", options.namespace);
  await ensureCacheServices(runner, options, [definition]);
  const container = runner.resources.container.get(names.container);
  if (!container) throw new Error("missing fixture container");
  container.State = { Running: false };
  record(container.NetworkSettings).Ports = {};
  expect(await ensureCacheServices(runner, options, [definition])).toEqual({ test: { host: "172.17.0.1", port: 40002 } });
  expect(runner.calls.some((call) => call[1] === "start" && call[2] === container.Id)).toBe(true);
  record(record(record(container.NetworkSettings).Networks)[names.network]).NetworkID = "foreign-id";
  runner.calls.length = 0;
  await expect(ensureCacheServices(runner, options, [{ ...definition, image: image.replace("a".repeat(64), "b".repeat(64)) }])).rejects.toThrow(/unexpected runtime configuration/);
  expect(runner.calls.some((call) => call[2] === "rm")).toBe(false);
});

it("keeps registry and APT protocol settings in their compiled definitions", () => {
  expect(dockerService.definition(image)).toMatchObject({ name: "docker", port: 5000, dataTarget: "/var/lib/registry", environment: { REGISTRY_PROXY_REMOTEURL: "https://registry-1.docker.io" } });
  expect(aptService.definition(image)).toMatchObject({ name: "apt", port: 3142, dataTarget: "/var/cache/apt-cacher-ng" });
  expect(cacheServiceNames("docker").container).not.toBe("dim-registry-cache");
});
function record(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new Error("invalid fixture object"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

it("fails before resource creation when Docker has no unambiguous IPv4 bridge gateway", async () => {
  for (const configs of [[], [{ Gateway: "0.0.0.0" }], [{ Gateway: "172.17.0.1" }, { Gateway: "172.18.0.1" }]]) {
    const options = await fixture(), runner = new Docker();
    const bridge = runner.resources.network.get("bridge");
    if (!bridge) throw new Error("missing fixture bridge");
    bridge.IPAM = { Config: configs };
    await expect(ensureCacheServices(runner, options, [definition])).rejects.toThrow(/IPv4 host gateway/);
    expect(runner.calls.every((call) => call[2] === "inspect")).toBe(true);
  }
});
