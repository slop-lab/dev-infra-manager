import { chmod, chown, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { loadNativeQemuConnection, NativeQemuConnectionError,
  parseNativeQemuConnection } from "../../../../core/packages/core/src/index.js";

const roots: string[] = [];
const capacity = { capacity: "primary",
  runnerBaseImage: `registry.example/dim/qemu-runner@sha256:${"c".repeat(64)}`,
  jobBaseImage: `registry.example/dim/qemu-job@sha256:${"d".repeat(64)}`,
  cpus: 4, memoryBytes: 8589934592, pids: 2048, timeoutSeconds: 3600, outputBytes: 16777216
} as const;
const valid = { schemaVersion: 1, hostId: "host-a",
  scheduler: { transport: "loopback-http", endpoint: "http://127.0.0.1:9080",
    serviceId: "qemu-main", hostToken: Buffer.alloc(32, 71).toString("base64url") },
  capacities: [capacity]
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function connectionFile(contents: unknown = valid): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-connection-"));
  roots.push(root);
  const path = join(root, "qemu.json");
  await writeFile(path, JSON.stringify(contents), { mode: 0o600 });
  return path;
}

describe("native QEMU host connection preflight", () => {
  it("parses only the exact host-scoped capacity and canonical origin", () => {
    expect(parseNativeQemuConnection(valid, "host-a")).toEqual(valid);
    const https = { ...valid, scheduler: { ...valid.scheduler, transport: "https",
      endpoint: "https://qemu.example" } };
    expect(parseNativeQemuConnection(https, "host-a")).toEqual(https);
  });

  it("rejects Gitea selectors, foreign hosts, mutable images, and unsafe scheduler authority", () => {
    for (const invalid of [
      { ...valid, projects: { acme: { apiToken: "foreign" } } },
      { ...valid, hostId: "host-b" },
      { ...valid, scheduler: { ...valid.scheduler, webhookUrl: "http://127.0.0.1:9080/v1/webhooks" } },
      { ...valid, scheduler: { ...valid.scheduler, hostToken: "weak" } },
      { ...valid, scheduler: { ...valid.scheduler, endpoint: "http://qemu.example" } },
      { ...valid, scheduler: { ...valid.scheduler, endpoint: "http://127.0.0.1:9080/v1" } },
      { ...valid, scheduler: { ...valid.scheduler, endpoint: "http://user:pass@127.0.0.1:9080" } },
      { ...valid, scheduler: { ...valid.scheduler, transport: "isolated-http" } },
      { ...valid, capacities: [capacity, capacity] },
      { ...valid, capacities: [{ ...capacity, jobBaseImage: "registry.example/job:latest" }] },
      { ...valid, capacities: [{ ...capacity, cpus: 0 }] },
      { ...valid, capacities: [{ ...capacity, labels: ["dim-qemu"] }] }
    ]) expect(() => parseNativeQemuConnection(invalid, "host-a")).toThrow(NativeQemuConnectionError);
  });

  it("reads only an owner-only single-link regular file", async () => {
    const path = await connectionFile();
    expect(await loadNativeQemuConnection(path, "host-a")).toEqual(valid);
    const linkRoot = await mkdtemp(join(tmpdir(), "dim-native-qemu-link-"));
    roots.push(linkRoot);
    const symlinkPath = join(linkRoot, "qemu.json");
    await symlink(path, symlinkPath);
    await expect(loadNativeQemuConnection(symlinkPath, "host-a")).rejects.toThrow(NativeQemuConnectionError);
    await link(path, join(linkRoot, "hardlink.json"));
    await expect(loadNativeQemuConnection(path, "host-a")).rejects.toThrow(NativeQemuConnectionError);
  });

  it("refuses a non-regular node or malformed JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-native-qemu-nonregular-"));
    roots.push(root);
    await expect(loadNativeQemuConnection(root, "host-a")).rejects.toThrow(NativeQemuConnectionError);
    const malformed = await connectionFile("not JSON");
    await expect(loadNativeQemuConnection(malformed, "host-a")).rejects.toThrow(NativeQemuConnectionError);
  });

  it.runIf(process.geteuid?.() === 0)("refuses a foreign-owned connection file", async () => {
    const path = await connectionFile();
    await chown(path, 65_534, 65_534);
    await expect(loadNativeQemuConnection(path, "host-a")).rejects.toThrow(NativeQemuConnectionError);
  });

  it("refuses an overpermissive or oversized file without parsing it", async () => {
    const path = await connectionFile();
    await chmod(path, 0o640);
    await expect(loadNativeQemuConnection(path, "host-a")).rejects.toThrow(NativeQemuConnectionError);
    const oversized = await connectionFile("x".repeat(64 * 1024 + 1));
    await expect(loadNativeQemuConnection(oversized, "host-a")).rejects.toThrow(NativeQemuConnectionError);
  });

  it("cannot enable native lifecycle or fall back to Gitea after a valid file is parsed", async () => {
    const path = await connectionFile();
    expect(await loadNativeQemuConnection(path, "host-a")).toEqual(valid);
    expect(() => lifecycleOptionsForBackend("sysbox", { HOME: "/home/dim",
      DIM_NATIVE_QEMU_CONNECTION_FILE: path, DIM_GITEA_CONNECTION_FILE: "/not-used" }))
      .toThrow(/native Project and QEMU adapters are unavailable; refusing Gitea fallback/);
  });
});
