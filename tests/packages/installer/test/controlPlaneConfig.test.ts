import { chown, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseControlPlaneConfig,
  readControlPlaneConfig
} from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import { writeControlPlaneFixture, writePrivate } from "./controlPlaneFixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-config-"));
  temporaryDirectories.push(directory);
  return writeControlPlaneFixture(directory);
}

describe("control-plane installer configuration", () => {
  it("reads the exact schema-1 mode-0600 owner file", async () => {
    const input = await fixture();
    const config = await readControlPlaneConfig(input.configPath, ["127.0.0.1", "::1"]);

    expect(config.schemaVersion).toBe(1);
    expect(config.nativeGit.publish).toEqual({ host: "127.0.0.1", port: 7443 });
    expect(config.ordinaryCi.image).toMatch(/@sha256:b{64}$/);
  });

  it.each([
    ["unknown field", (value: Record<string, unknown>) => ({ ...value, extra: true })],
    ["tagged image", (value: Record<string, unknown>) => ({ ...value, nativeGit: { ...record(value.nativeGit), image: "registry.example/native:latest" } })],
    ["wildcard host", (value: Record<string, unknown>) => ({ ...value, nativeGit: { ...record(value.nativeGit), publish: { host: "0.0.0.0", port: 7443 } } })],
    ["foreign address", (value: Record<string, unknown>) => ({ ...value, nativeGit: { ...record(value.nativeGit), publish: { host: "192.0.2.20", port: 7443 } } })],
    ["shared port", (value: Record<string, unknown>) => ({ ...value, ordinaryCi: { ...record(value.ordinaryCi), publish: { host: "127.0.0.1", port: 7443 } } })]
  ])("rejects %s", async (_label, mutate) => {
    const input = await fixture();
    expect(() => parseControlPlaneConfig(mutate({ ...input.config }), ["127.0.0.1", "::1"])).toThrow();
  });

  it("rejects malformed JSON and symlinked config paths", async () => {
    const input = await fixture();
    await writePrivate(input.configPath, "{\n");
    await expect(readControlPlaneConfig(input.configPath, ["127.0.0.1"])).rejects.toThrow();

    const link = join(join(input.configPath, ".."), "linked.json");
    await symlink(input.configPath, link);
    await expect(readControlPlaneConfig(link, ["127.0.0.1"])).rejects.toThrow();

  });

  it.runIf(process.geteuid?.() === 0)("rejects a foreign-owned config path", async () => {
    const input = await fixture();
    await chown(input.configPath, 65_534, 65_534);
    await expect(readControlPlaneConfig(input.configPath, ["127.0.0.1"])).rejects.toThrow(/owned/);
  });
});

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError("fixture value is not a record");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
