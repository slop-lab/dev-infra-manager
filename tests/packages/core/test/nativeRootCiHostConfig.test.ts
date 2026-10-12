import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeRootCiHostConfig,
  parseNativeRootCiAdmissionConfig,
  parseNativeRootCiHostConfig
} from "../../../../core/packages/core/src/nativeRootCiHostConfig.js";

const roots: string[] = [];
const generationId = "a".repeat(64);
const token = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("native root CI host configuration", () => {
  it("parses one node with multiple fixed capacities and distinct host-only credentials", () => {
    // Given
    const input = hostConfig();

    // When
    const parsed = parseNativeRootCiHostConfig(input);

    // Then
    expect(parsed).toEqual(input);
    expect(parsed.capacities).toEqual(["primary", "secondary"]);
  });

  it.each([
    ["duplicate capacity", { capacities: ["primary", "primary"] }],
    ["host identity mismatch", { ordinaryCi: { ...hostConfig().ordinaryCi,
      credential: { ...hostConfig().ordinaryCi.credential, username: "host-b" } } }],
    ["mutable generation", { generationId: "not-a-generation" }],
    ["non-loopback plain HTTP", { ordinaryCi: { ...hostConfig().ordinaryCi,
      endpoint: "http://ordinary.example" } }],
    ["obsolete worker attempt authority", { nativeGit: { ...hostConfig().nativeGit,
      attemptIssuer: { username: "ordinary-attempts", password: token(2) } } }],
    ["obsolete owner read authority", { nativeGit: { ...hostConfig().nativeGit,
      rootReadIssuer: { username: "root-reader-host-a", password: token(3) } } }]
  ])("rejects %s", (_label, changed) => {
    // Given
    const input = { ...hostConfig(), ...changed };

    // When / Then
    expect(() => parseNativeRootCiHostConfig(input)).toThrow(/native root CI host config/i);
  });

  it("loads only an unchanged owner-only single-link regular file", async () => {
    // Given
    const root = await temporaryRoot();
    const path = join(root, "host.json");
    await writeFile(path, JSON.stringify(hostConfig()), { mode: 0o600 });

    // When
    const loaded = await loadNativeRootCiHostConfig(path);

    // Then
    expect(loaded.hostId).toBe("host-a");
    await chmod(path, 0o644);
    await expect(loadNativeRootCiHostConfig(path)).rejects.toThrow(/owner-only/);
    await chmod(path, 0o600);
    await link(path, join(root, "second-link.json"));
    await expect(loadNativeRootCiHostConfig(path)).rejects.toThrow(/owner-only/);
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(hostConfig()), { mode: 0o600 });
    const symbolic = join(root, "symbolic.json");
    await symlink(target, symbolic);
    await expect(loadNativeRootCiHostConfig(symbolic)).rejects.toThrow(/safely/);
  });

  it("rejects a relative private config path before opening it", async () => {
    // Given
    const path = "relative-host.json";

    // When
    const loaded = loadNativeRootCiHostConfig(path);

    // Then
    await expect(loaded).rejects.toThrow(/path must be absolute/);
  });

  it("parses a workspace-free central admission config", () => {
    // Given
    const input = {
      schemaVersion: 1,
      generationId,
      ordinaryCi: {
        transport: "loopback-http",
        endpoint: "http://127.0.0.1:8080",
        serviceId: "ordinary-main",
        registrar: { username: "ordinary-registrar", password: token(4) }
      }
    } as const;

    // When / Then
    expect(parseNativeRootCiAdmissionConfig(input)).toEqual(input);
    expect(() => parseNativeRootCiAdmissionConfig({ ...input, workspace: "work-1" })).toThrow();
  });
});

function hostConfig() {
  return {
    schemaVersion: 1,
    hostId: "host-a",
    generationId,
    stateDirectory: "/var/lib/dim/native-root-ci-host",
    gitExecutable: "/usr/bin/git",
    ordinaryCi: {
      transport: "loopback-http",
      endpoint: "http://127.0.0.1:8080",
      serviceId: "ordinary-main",
      credential: { username: "host-a", password: token(1) }
    },
    nativeGit: {
      transport: "loopback-http",
      endpoint: "http://127.0.0.1:9080",
      serviceId: "native-main"
    },
    capacities: ["primary", "secondary"]
  } as const;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-ci-host-config-"));
  roots.push(root);
  return root;
}
