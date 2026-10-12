import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { NativeQemuAuthorityClient } from "../../../../core/packages/core/src/nativeQemuAuthorityClient.js";
import type { NativeQemuCapacity, NativeQemuSchedulerConfig }
  from "../../../../core/packages/core/src/nativeQemuSchedulerConfig.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/core/src/nativeQemuSchedulerService.js";

const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");
const capacity = (name: string): NativeQemuCapacity => ({ capacity: name,
  runnerBaseImage: `runner@sha256:${"1".repeat(64)}`, jobBaseImage: `job@sha256:${"2".repeat(64)}`,
  bounds: { cpu: "2", memoryBytes: "1024", pids: "64", wallClockSeconds: "60", outputBytes: "1024" } });

describe("native QEMU scheduler execution authority binding", () => {
  it("persists exact non-secret authority metadata and preserves generation on an unchanged restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-authority-"));
    const config = schedulerConfig(join(root, "qemu.sqlite3"));
    await startAndClose(config);
    const initial = metadata(config.database);

    await startAndClose({ ...config, hosts: [...config.hosts].reverse()
      .map((host) => ({ ...host, capacities: [...host.capacities].reverse() })) });
    const restarted = metadata(config.database);

    expect(initial).toEqual({ execution_authority_json: JSON.stringify([
      { hostId: "node-a", capacities: [capacity("kvm-1"), capacity("kvm-2")] },
      { hostId: "node-b", capacities: [capacity("kvm-1")] }
    ]), schema_version: "3", service_generation_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(restarted).toEqual(initial);
    expect(JSON.stringify(initial)).not.toContain(token("g"));
    expect(JSON.stringify(initial)).not.toContain(token("h"));
  });

  it("creates a new generation UUID for a deliberately fresh database", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-authority-rotation-"));
    const first = schedulerConfig(join(root, "first.sqlite3"));
    const rotated = { ...first, database: join(root, "rotated.sqlite3") };

    await startAndClose(first);
    await startAndClose(rotated);

    expect(metadata(rotated.database).service_generation_id)
      .not.toBe(metadata(first.database).service_generation_id);
  });

  it.each([
    ["changed host ID", (config: NativeQemuSchedulerConfig): NativeQemuSchedulerConfig => ({ ...config,
      hosts: config.hosts.map((host) => host.hostId === "node-a" ? { ...host, hostId: "node-c" } : host) })],
    ["removed capacity", (config: NativeQemuSchedulerConfig): NativeQemuSchedulerConfig => ({ ...config,
      hosts: config.hosts.map((host) => host.hostId === "node-a"
        ? { ...host, capacities: host.capacities.filter(({ capacity: name }) => name !== "kvm-2") } : host) })],
    ["changed capacity name", (config: NativeQemuSchedulerConfig): NativeQemuSchedulerConfig => ({ ...config,
      hosts: config.hosts.map((host) => host.hostId === "node-a" ? { ...host,
        capacities: host.capacities.map((entry) => entry.capacity === "kvm-1"
          ? { ...entry, capacity: "kvm-3" } : entry) } : host) })],
    ["changed runner image", (config: NativeQemuSchedulerConfig): NativeQemuSchedulerConfig => ({ ...config,
      hosts: config.hosts.map((host) => host.hostId === "node-a" ? { ...host,
        capacities: host.capacities.map((entry) => entry.capacity === "kvm-1" ? { ...entry,
          runnerBaseImage: `runner@sha256:${"3".repeat(64)}` } : entry) } : host) })],
    ["changed job image", (config: NativeQemuSchedulerConfig): NativeQemuSchedulerConfig => ({ ...config,
      hosts: config.hosts.map((host) => host.hostId === "node-a" ? { ...host,
        capacities: host.capacities.map((entry) => entry.capacity === "kvm-1" ? { ...entry,
          jobBaseImage: `job@sha256:${"3".repeat(64)}` } : entry) } : host) })],
    ["changed bounds", (config: NativeQemuSchedulerConfig): NativeQemuSchedulerConfig => ({ ...config,
      hosts: config.hosts.map((host) => host.hostId === "node-a" ? { ...host,
        capacities: host.capacities.map((entry) => entry.capacity === "kvm-1" ? { ...entry,
          bounds: { ...entry.bounds, memoryBytes: "2048" } } : entry) } : host) })]
  ])("rejects startup with %s while retaining durable metadata", async (_label, mutate) => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-authority-drift-"));
    const config = schedulerConfig(join(root, "qemu.sqlite3"));
    await startAndClose(config);
    const before = metadata(config.database);

    const error = await startupError(mutate(config));

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/database|authority|configuration/i);
    expect(metadata(config.database)).toEqual(before);
  });
});

async function startAndClose(config: NativeQemuSchedulerConfig): Promise<void> {
  const server = configuredNativeQemuSchedulerServer(config, authority);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function startupError(config: NativeQemuSchedulerConfig): Promise<unknown> {
  try {
    await startAndClose(config);
    return undefined;
  } catch (error) { return error; }
}

function metadata(path: string): Readonly<Record<string, string>> {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(database.prepare("SELECT key,value FROM native_qemu_metadata").all()
    .map((row) => [String(row.key), String(row.value)])); }
  finally { database.close(); }
}

function schedulerConfig(database: string): NativeQemuSchedulerConfig {
  return { schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1", port: 0, database,
    eligibilityLeaseMilliseconds: 120_000, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://127.0.0.1:9080", serviceId: "native-main",
      identity: { username: "identity", password: token("a") },
      attemptIssuer: { username: "attempts", password: token("b") },
      candidateReader: { username: "reader", password: token("c") },
      resultReporter: { username: "results", password: token("d") } },
    credentials: { eventIntake: { username: "events", password: token("e") },
      query: { username: "query", password: token("f") } },
    hosts: [{ hostId: "node-b", hostToken: token("h"), capacities: [capacity("kvm-1")] },
      { hostId: "node-a", hostToken: token("g"), capacities: [capacity("kvm-2"), capacity("kvm-1")] }] };
}

const authority: NativeQemuAuthorityClient = {
  async readPolicy(projectId) { return { projectId, policyRevision: "a", requiredJobSetRevision: "b",
    requiredQemuJobs: [] }; },
  async proveEvent() {}, async issue() { throw new TypeError("unused"); },
  async candidateLease() { throw new TypeError("unused"); }, async report() {}, async revoke() {}
};
