import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeNativeOrdinaryBundleState } from "../../../../core/packages/core/src/nativeOrdinaryBundleState.js";
import { ordinaryBundleConfig, ordinaryBundleSecrets } from "./nativeOrdinaryBundleConfigFixture.js";

const run = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const packageRoot = join(workspaceRoot, "core/packages/core");
const serviceCli = join(packageRoot, "dist/nativeOrdinaryServiceCli.js");
const stateProbe = join(import.meta.dirname, "fixtures/nativeOrdinaryStateProbeProcess.mjs");
const roots: string[] = [];

beforeAll(async () => {
  await run("pnpm", ["run", "build"], { cwd: packageRoot });
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI image configuration preflight CLI", () => {
  it("accepts an exact private read-only schema-3 bundle file without changing its bytes", async () => {
    // Given
    const config = await fixtureFile("ordinary.json", ordinaryBundleConfig());
    const before = await readFile(config);

    // When
    const result = await invoke(["check-config", config]);

    // Then
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(await readFile(config)).toEqual(before);
  });

  it("reports exact compatibility metadata from the built executable", async () => {
    // Given / When
    const result = await invoke(["compatibility", "--json"]);

    // Then
    expect(result).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ schemaVersion: 1, writeFormat: 3, readableFormats: [3] })}\n`,
      stderr: ""
    });
  });

  it("checks mounted schema-3 state through the built process without changing the read-only target", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-cli-state-"));
    roots.push(root);
    await chmod(root, 0o750);
    await initializeNativeOrdinaryBundleState(root);
    const before = await stateTree(root);

    // When
    const result = await run(process.execPath, [stateProbe, root]);

    // Then
    expect(result.stdout).toBe(`${JSON.stringify({ schemaVersion: 1, stateFormat: 3 })}\n`);
    expect(result.stderr).toBe("");
    expect(await stateTree(root)).toEqual(before);
  });

  it("checks idle live-WAL state without changing any source artifact", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-cli-live-wal-"));
    roots.push(root);
    await chmod(root, 0o750);
    const state = await initializeNativeOrdinaryBundleState(root);
    const database = new DatabaseSync(state.database);
    database.exec("PRAGMA journal_mode = WAL");
    database.prepare("INSERT INTO bundle_activation VALUES (?, ?)").run("a".repeat(64), "b".repeat(64));
    try {
      const before = await stateTree(root);
      expect(before.map(({ entry }) => entry)).toEqual([
        "ordinary-ci.sqlite3",
        "ordinary-ci.sqlite3-shm",
        "ordinary-ci.sqlite3-wal",
        "state-format.json"
      ]);

      // When
      const result = await run(process.execPath, [stateProbe, root]);

      // Then
      expect(result.stdout).toBe(`${JSON.stringify({ schemaVersion: 1, stateFormat: 3 })}\n`);
      expect(result.stderr).toBe("");
      expect(await stateTree(root)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it.each([
    ["malformed JSON", () => "{", /valid JSON/],
    ["an unknown field", () => ({ ...ordinaryBundleConfig(), obsolete: true }), /invalid ordinary CI bundle configuration/],
    ["the wrong schema", () => ({ ...ordinaryBundleConfig(), schemaVersion: 2 }), /invalid ordinary CI bundle configuration/],
    ["the wrong database", () => ({ ...ordinaryBundleConfig(), database: "/tmp/ordinary.sqlite3" }), /database path/],
    ["the wrong service ID", () => ({ ...ordinaryBundleConfig(), serviceId: "ordinary-other" }), /service ID/],
    ["the wrong native origin", () => {
      const config = ordinaryBundleConfig();
      return { ...config, nativeGit: { ...config.nativeGit, endpoint: "http://localhost:8080" } };
    }, /native Git identity/],
    ["obsolete second leases", () => {
      const { admissionLeaseMilliseconds: _admission, claimLeaseMilliseconds: _claim, ...config } = ordinaryBundleConfig();
      return { ...config, admissionLeaseSeconds: 300, claimLeaseSeconds: 60 };
    }, /invalid ordinary CI bundle configuration/],
    ["map-shaped hosts", () => ({ ...ordinaryBundleConfig(), hosts: { "host-a": {} } }), /invalid ordinary CI bundle configuration/],
    ["shared role authority", () => {
      const config = ordinaryBundleConfig();
      return { ...config, credentials: {
        ...config.credentials,
        registrar: { username: "ordinary-registrar", password: ordinaryBundleSecrets.webhook }
      } };
    }, /credentials must be globally distinct/],
    ["a weak role credential", () => {
      const config = ordinaryBundleConfig();
      return { ...config, credentials: {
        ...config.credentials,
        registrar: { username: "ordinary-registrar", password: Buffer.alloc(31, 1).toString("base64url") }
      } };
    }, /credential token/],
    ["a weak host credential", () => {
      const config = ordinaryBundleConfig();
      return { ...config, hosts: config.hosts.map((host) => ({
        ...host,
        hostToken: Buffer.alloc(31, 1).toString("base64url")
      })) };
    }, /host token/],
    ["a mutable runner image", () => {
      const config = ordinaryBundleConfig();
      return { ...config, hosts: config.hosts.map((host) => ({
        ...host,
        capacities: host.capacities.map((capacity) => ({ ...capacity, runnerBaseImage: "registry.example/runner:latest" }))
      })) };
    }, /runner base image/],
    ["a non-positive capacity ceiling", () => {
      const config = ordinaryBundleConfig();
      return { ...config, hosts: config.hosts.map((host) => ({
        ...host,
        capacities: host.capacities.map((capacity) => ({
          ...capacity,
          bounds: { ...capacity.bounds, cpu: "0" }
        }))
      })) };
    }, /CPU/]
  ])("rejects %s without disclosing credentials or changing bytes", async (_label, value, message) => {
    // Given
    const config = await fixtureFile("ordinary.json", value());
    const before = await readFile(config);

    // When
    const result = await invoke(["check-config", config]);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toContain(ordinaryBundleSecrets.webhook);
    expect(await readFile(config)).toEqual(before);
  });

  it.each([[[]], [["check-config"]], [["unknown"]], [["check-state", "/tmp/config.json"]],
    [["check-state", "--read-only", "/tmp/state", "--json"]], [["serve", "/tmp/service.json"]],
    [["serve", "/run/secrets/service.json", "not-a-generation"]], [["activate"]], [["activate", "not-a-generation"]],
    [["check-config", "a", "b"]]])(
    "rejects unknown argv %j without inventing a command response",
    async (arguments_) => {
      // Given / When
      const result = await invoke(arguments_);

      // Then
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^usage: dim-service check-config/);
    }
  );

  it("publishes dim-service as the built ordinary image preflight executable", async () => {
    // Given / When
    const packageJson: unknown = JSON.parse(await readFile(join(packageRoot, "dist/package.json"), "utf8"));

    // Then
    expect(packageJson).toMatchObject({ bin: { "dim-service": "nativeOrdinaryServiceCli.js" } });
  });
});

async function fixtureFile(name: string, value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-ordinary-bundle-config-"));
  roots.push(root);
  const file = join(root, name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  await chmod(file, 0o444);
  return file;
}

async function stateTree(root: string): Promise<readonly StateTreeEntry[]> {
  return Promise.all((await readdir(root)).sort().map(async (entry) => {
    const path = join(root, entry);
    const metadata = await stat(path, { bigint: true });
    return {
      entry,
      bytes: await readFile(path),
      size: metadata.size,
      mtimeNanoseconds: metadata.mtimeNs,
      ctimeNanoseconds: metadata.ctimeNs
    };
  }));
}

async function invoke(args: readonly string[]): Promise<ProcessResult> {
  try {
    const result = await run(process.execPath, [serviceCli, ...args]);
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "number"
      && "stdout" in error && typeof error.stdout === "string"
      && "stderr" in error && typeof error.stderr === "string") {
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

type ProcessResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

type StateTreeEntry = {
  readonly entry: string;
  readonly bytes: Buffer;
  readonly size: bigint;
  readonly mtimeNanoseconds: bigint;
  readonly ctimeNanoseconds: bigint;
};
