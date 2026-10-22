import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { bundleSecrets, idleNativeConfig, idleExecutionConfig } from "../plugins/git-repositories/bundleConfigFixture.js";

const run = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const packageRoot = join(workspaceRoot, "packages/control-plane/plugins/git-repositories");
const serviceCli = join(workspaceRoot, "packages/control-plane/deployment/dist/deployment-cli.js");
const stateProbe = join(import.meta.dirname, "../plugins/git-repositories/fixtures/nativeStateProbeProcess.ts");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git image configuration preflight CLI", () => {
  it("accepts exact read-only idle native and execution bundle files without changing their bytes", async () => {
    // Given
    const native = await fixtureFile("native.json", idleNativeConfig());
    const execution = await fixtureFile("execution.json", idleExecutionConfig());
    const before = await Promise.all([readFile(native), readFile(execution)]);

    // When
    const own = await invoke(["check-config", native]);
    const bundle = await invoke(["check-bundle-config", native, execution]);

    // Then
    expect([own.status, bundle.status]).toEqual([0, 0]);
    expect(await Promise.all([readFile(native), readFile(execution)])).toEqual(before);
  });

  it.each([
    ["malformed JSON", "{", /valid JSON/],
    ["the obsolete installed schema", { ...idleNativeConfig(), schemaVersion: 5 }, /invalid native Git bundle configuration/],
    ["a missing registrar list", withoutProjectRegistrars(), /invalid native Git bundle configuration/],
    ["a missing root importer list", withoutProjectRootImporters(), /invalid native Git bundle configuration/],
    ["a missing root read issuer list", withoutProjectRootReadIssuers(), /invalid native Git bundle configuration/],
    ["a missing workspace write issuer list", withoutWorkspaceWriteIssuers(), /invalid native Git bundle configuration/],
    ["an unknown field", { ...idleNativeConfig(), obsolete: true }, /invalid native Git bundle configuration/],
    ["a registrar with a missing field", {
      ...idleNativeConfig(), projectRegistrars: [{ hostId: "controller-a", username: "project-registrar-a" }]
    }, /invalid native Git bundle configuration/],
    ["a registrar with an unknown field", {
      ...idleNativeConfig(), projectRegistrars: [{
        hostId: "controller-a", username: "project-registrar-a",
        password: bundleSecrets.projectRegistrar, scope: "project"
      }]
    }, /invalid native Git bundle configuration/],
    ["a root importer with a noncanonical password", {
      ...idleNativeConfig(), projectRootImporters: [{
        hostId: "controller-a", username: "project-root-importer-a",
        password: Buffer.alloc(31, 10).toString("base64url")
      }]
    }, /invalid native Git bundle configuration/],
    ["a root importer with an invalid host ID", {
      ...idleNativeConfig(), projectRootImporters: [{
        hostId: "Controller A", username: "project-root-importer-a",
        password: bundleSecrets.projectRootImporter
      }]
    }, /invalid native Git bundle configuration/],
    ["a root importer with an unknown field", {
      ...idleNativeConfig(), projectRootImporters: [{
        hostId: "controller-a", username: "project-root-importer-a",
        password: bundleSecrets.projectRootImporter, scope: "bootstrap"
      }]
    }, /invalid native Git bundle configuration/],
    ["a root read issuer with an unknown field", {
      ...idleNativeConfig(), projectRootReadIssuers: [{
        hostId: "controller-a", username: "project-root-read-issuer-a",
        password: bundleSecrets.projectRootReadIssuer, scope: "read"
      }]
    }, /invalid native Git bundle configuration/],
    ["a workspace write issuer with an unknown field", {
      ...idleNativeConfig(), workspaceWriteIssuers: [{
        hostId: "controller-a", username: "workspace-write-issuer-a",
        password: bundleSecrets.workspaceWriteIssuer, scope: "write"
      }]
    }, /invalid native Git bundle configuration/],
    ["an obsolete documented shape", {
      ...idleNativeConfig(),
      execution: { endpoint: "http://execution:8080", serviceId: "execution-main" }
    }, /invalid native Git bundle configuration/],
    ["a repository registration", {
      ...idleNativeConfig(),
      repositories: [{ projectId: "project-a", repositoryId: "root" }]
    }, /invalid native Git bundle configuration/],
    ["a Project identity", {
      ...idleNativeConfig(),
      identities: [{
        role: "reader", username: "reader-a", password: bundleSecrets.registrar,
        projectId: "project-a", repositoryIds: ["root"]
      }]
    }, /invalid native Git bundle configuration/],
    ["the wrong listener", { ...idleNativeConfig(), host: "127.0.0.1" }, /listener must be 0\.0\.0\.0:8080/],
    ["the wrong storage root", { ...idleNativeConfig(), storageRoot: "/tmp/native-git" }, /storage root/]
  ])("check-config rejects %s without disclosing credentials", async (_label, value, message) => {
    // Given
    const native = await fixtureFile("native.json", value);

    // When
    const result = await invoke(["check-config", native]);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toContain(bundleSecrets.registrar);
  });

  it.each([
    ["host IDs", { hostId: "controller-a", username: "project-registrar-b", password: bundleSecrets.unpaired }],
    ["usernames", { hostId: "controller-b", username: "project-registrar-a", password: bundleSecrets.unpaired }],
    ["passwords", { hostId: "controller-b", username: "project-registrar-b", password: bundleSecrets.projectRegistrar }],
    ["cross-role secrets", {
      hostId: "controller-b", username: "project-registrar-b",
      password: idleNativeConfig().ci.grantIssuer.password
    }]
  ])("check-config rejects duplicate registrar %s", async (_label, secondRegistrar) => {
    // Given
    const firstRegistrar = {
      hostId: "controller-a", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
    };
    const native = await fixtureFile("native.json", {
      ...idleNativeConfig(), projectRegistrars: [firstRegistrar, secondRegistrar]
    });

    // When
    const result = await invoke(["check-config", native]);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/distinct/);
    expect(result.stderr).not.toContain(bundleSecrets.projectRegistrar);
  });

  it.each([
    ["host IDs", { hostId: "controller-a", username: "project-root-importer-b", password: bundleSecrets.unpaired }],
    ["usernames", { hostId: "controller-b", username: "project-root-importer-a", password: bundleSecrets.unpaired }],
    ["passwords", { hostId: "controller-b", username: "project-root-importer-b", password: bundleSecrets.projectRootImporter }],
    ["native registrar credentials", {
      hostId: "controller-b", username: "project-registrar-a", password: bundleSecrets.unpaired
    }],
    ["service credentials", {
      hostId: "controller-b", username: "project-root-importer-b",
      password: idleNativeConfig().ci.grantIssuer.password
    }]
  ])("check-config rejects duplicate root importer %s", async (_label, secondImporter) => {
    // Given
    const firstImporter = {
      hostId: "controller-a", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
    };
    const native = await fixtureFile("native.json", {
      ...idleNativeConfig(),
      projectRegistrars: [{
        hostId: "controller-c", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
      }],
      projectRootImporters: [firstImporter, secondImporter]
    });

    // When
    const result = await invoke(["check-config", native]);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/distinct/);
    expect(result.stderr).not.toContain(bundleSecrets.projectRootImporter);
  });

  it("accepts distinct registrar and root importer credentials for the same trusted host", async () => {
    // Given
    const native = await fixtureFile("native.json", {
      ...idleNativeConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "host-a", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
      }]
    });

    // When
    const result = await invoke(["check-config", native]);

    // Then
    expect(result.status).toBe(0);
  });

  it("accepts distinct registrar, importer, read issuer, and write issuer credentials for one host", async () => {
    // Given
    const native = await fixtureFile("native.json", {
      ...idleNativeConfig(),
      projectRegistrars: [{
        hostId: "host-a", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "host-a", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
      }],
      projectRootReadIssuers: [{
        hostId: "host-a", username: "project-root-read-issuer-a", password: bundleSecrets.projectRootReadIssuer
      }],
      workspaceWriteIssuers: [{
        hostId: "host-a", username: "workspace-write-issuer-a", password: bundleSecrets.workspaceWriteIssuer
      }]
    });

    // When
    const result = await invoke(["check-config", native]);

    // Then
    expect(result.status).toBe(0);
  });

  it.each([
    ["host IDs", { hostId: "controller-a", username: "project-root-read-issuer-b", password: bundleSecrets.unpaired }],
    ["usernames", { hostId: "controller-b", username: "project-root-read-issuer-a", password: bundleSecrets.unpaired }],
    ["passwords", { hostId: "controller-b", username: "project-root-read-issuer-b", password: bundleSecrets.projectRootReadIssuer }],
    ["registrar credentials", {
      hostId: "controller-b", username: "project-registrar-a", password: bundleSecrets.unpaired
    }],
    ["importer credentials", {
      hostId: "controller-b", username: "project-root-read-issuer-b", password: bundleSecrets.projectRootImporter
    }],
    ["service credentials", {
      hostId: "controller-b", username: idleNativeConfig().ci.grantIssuer.username,
      password: bundleSecrets.unpaired
    }]
  ])("check-config rejects duplicate root read issuer %s", async (_label, secondIssuer) => {
    // Given
    const native = await fixtureFile("native.json", {
      ...idleNativeConfig(),
      projectRegistrars: [{
        hostId: "controller-c", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "controller-c", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
      }],
      projectRootReadIssuers: [{
        hostId: "controller-a", username: "project-root-read-issuer-a",
        password: bundleSecrets.projectRootReadIssuer
      }, secondIssuer]
    });

    // When
    const result = await invoke(["check-config", native]);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/distinct/);
    expect(result.stderr).not.toContain(bundleSecrets.projectRootReadIssuer);
  });

  it.each([
    ["host IDs", { hostId: "controller-a", username: "workspace-write-issuer-b", password: bundleSecrets.unpaired }],
    ["usernames", { hostId: "controller-b", username: "workspace-write-issuer-a", password: bundleSecrets.unpaired }],
    ["passwords", { hostId: "controller-b", username: "workspace-write-issuer-b", password: bundleSecrets.workspaceWriteIssuer }],
    ["registrar credentials", {
      hostId: "controller-b", username: "project-registrar-a", password: bundleSecrets.unpaired
    }],
    ["importer credentials", {
      hostId: "controller-b", username: "workspace-write-issuer-b", password: bundleSecrets.projectRootImporter
    }],
    ["root read issuer credentials", {
      hostId: "controller-b", username: "workspace-write-issuer-b", password: bundleSecrets.projectRootReadIssuer
    }],
    ["service credentials", {
      hostId: "controller-b", username: idleNativeConfig().ci.grantIssuer.username, password: bundleSecrets.unpaired
    }]
  ])("check-config rejects duplicate workspace write issuer %s", async (_label, secondIssuer) => {
    const native = await fixtureFile("native.json", {
      ...idleNativeConfig(),
      projectRegistrars: [{
        hostId: "controller-c", username: "project-registrar-a", password: bundleSecrets.projectRegistrar
      }],
      projectRootImporters: [{
        hostId: "controller-c", username: "project-root-importer-a", password: bundleSecrets.projectRootImporter
      }],
      projectRootReadIssuers: [{
        hostId: "controller-c", username: "project-root-read-issuer-a", password: bundleSecrets.projectRootReadIssuer
      }],
      workspaceWriteIssuers: [{
        hostId: "controller-a", username: "workspace-write-issuer-a", password: bundleSecrets.workspaceWriteIssuer
      }, secondIssuer]
    });

    const result = await invoke(["check-config", native]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/distinct/);
    expect(result.stderr).not.toContain(bundleSecrets.workspaceWriteIssuer);
  });

  it.each([
    ["mismatched paired credentials", () => {
      const execution = idleExecutionConfig();
      return { ...execution, nativeGit: { ...execution.nativeGit, grantIssuer: { ...execution.nativeGit.grantIssuer, password: bundleSecrets.unpaired } } };
    }, /paired credentials/],
    ["shared role secrets", () => {
      const execution = idleExecutionConfig();
      return { ...execution, workers: execution.workers.map((host) => ({
        ...host, token: bundleSecrets.webhook
      })) };
    }, /invalid execution scheduler configuration/],
    ["an unknown execution field", () => ({ ...idleExecutionConfig(), obsolete: true }), /invalid execution scheduler configuration/],
    ["the wrong native service origin", () => {
      const execution = idleExecutionConfig();
      return { ...execution, nativeGit: { ...execution.nativeGit, endpoint: "http://localhost:8080" } };
    }, /paired CI deployment requires its private native Git endpoint/],
    ["the wrong reciprocal service ID", () => {
      const execution = idleExecutionConfig();
      return { ...execution, nativeGit: { ...execution.nativeGit, serviceId: "native-other" } };
    }, /invalid execution scheduler configuration/],
    ["a short decoded host token", () => {
      const execution = idleExecutionConfig();
      return { ...execution, workers: execution.workers.map((host) => ({
        ...host,
        token: Buffer.alloc(31, 8).toString("base64url")
      })) };
    }, /invalid execution scheduler configuration/]
  ])("check-bundle-config rejects %s before state access", async (_label, executionValue, message) => {
    // Given
    const native = await fixtureFile("native.json", idleNativeConfig());
    const execution = await fixtureFile("execution.json", executionValue());
    const before = await Promise.all([readFile(native), readFile(execution)]);

    // When
    const result = await invoke(["check-bundle-config", native, execution]);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toContain(bundleSecrets.webhook);
    expect(await Promise.all([readFile(native), readFile(execution)])).toEqual(before);
  });

  it("reports exact native-state compatibility metadata from the built executable", async () => {
    // Given / When
    const result = await invoke(["compatibility", "--json"]);

    // Then
    expect(result).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ schemaVersion: 1, writeFormat: 12, readableFormats: [10, 11, 12] })}\n`,
      stderr: ""
    });
  });

  it("checks generated native state through the built process without changing bytes or mtimes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-cli-state-"));
    roots.push(root);
    const initialize = await import("../../../packages/control-plane/plugins/git-repositories/src/native-bundle-state.js");
    const state = await initialize.initializeNativeGitBundleState(root);
    await state.owner.release();
    const before = await stateTree(root);

    // When
    const result = await run(process.execPath, [stateProbe, root]);

    // Then
    expect(result.stdout).toBe(`${JSON.stringify({ schemaVersion: 1, stateFormat: 12 })}\n`);
    expect(result.stderr).toBe("");
    expect(await stateTree(root)).toEqual(before);
  });

  it("keeps the native Git authority package independent of service composition", async () => {
    // Given / When
    const packageJson: unknown = JSON.parse(await readFile(join(packageRoot, "dist/package.json"), "utf8"));

    // Then
    expect(packageJson).toMatchObject({ name: "@slop-lab/dim-control-plane-plugin-git-repositories" });
    expect(Reflect.get(Object(packageJson), "bin")).toBeUndefined();
  });

  it.each([
    ["serve", "/run/secrets/service.json"],
    ["serve", "/run/secrets/service.json", "not-a-generation"],
    ["activate"],
    ["activate", "not-a-generation"]
  ])("rejects generation-unbound service argv %j", async (...arguments_) => {
    const result = await invoke(arguments_);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^usage: dim-service/);
  });
});

async function fixtureFile(name: string, value: unknown, mode = 0o444): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-bundle-config-"));
  roots.push(root);
  const file = join(root, name);
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  await chmod(file, mode);
  return file;
}

async function invoke(args: readonly string[]): Promise<ProcessResult> {
  return runProcess(serviceCli, args);
}

async function runProcess(file: string, args: readonly string[]): Promise<ProcessResult> {
  try {
    const result = await run(process.execPath, [file, ...args]);
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

function withoutProjectRegistrars(): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(idleNativeConfig()).filter(([key]) => key !== "projectRegistrars"));
}

function withoutProjectRootImporters(): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(idleNativeConfig()).filter(([key]) => key !== "projectRootImporters"));
}

function withoutProjectRootReadIssuers(): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(idleNativeConfig()).filter(([key]) => key !== "projectRootReadIssuers"));
}

function withoutWorkspaceWriteIssuers(): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(idleNativeConfig()).filter(([key]) => key !== "workspaceWriteIssuers"));
}

async function stateTree(root: string): Promise<readonly StateTreeEntry[]> {
  return Promise.all((await readdir(root)).sort().map(async (entry) => {
    const path = join(root, entry);
    const metadata = await stat(path, { bigint: true });
    return { entry, bytes: await readFile(path), mtimeNanoseconds: metadata.mtimeNs };
  }));
}

type StateTreeEntry = {
  readonly entry: string;
  readonly bytes: Buffer;
  readonly mtimeNanoseconds: bigint;
};
