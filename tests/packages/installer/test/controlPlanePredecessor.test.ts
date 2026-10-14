import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";
import { deterministicRandom, exists, installFixture } from "./controlPlaneInstallTestSupport.js";

describe("control-plane predecessor preflight", () => {
  it.each([
    "DIM_GITEA_CONNECTION_FILE",
    "DIM_GIT_SYNC_CONNECTION_FILE",
    "DIM_QEMU_SCHEDULER_CONNECTION_FILE",
    "DIM_ORDINARY_CI_POOL_CONNECTION_FILE"
  ])("rejects an empty obsolete %s selector before config, installer state, or Docker", async (selector) => {
    // Given: the obsolete selector is present with an empty value and all later inputs are invalid.
    const input = await installFixture();
    const runner = new FirstInstallRunner();

    // When: installation begins.
    const action = installControlPlane({
      configPath: join(input.stateRoot, "missing-config.json"), stateRoot: input.stateRoot, runner,
      environment: { [selector]: "" }
    });

    // Then: predecessor selection wins without reading the path or touching later boundaries.
    await expect(action).rejects.toThrow(new RegExp(selector));
    expect(runner.calls).toEqual([]);
    expect(await exists(input.stateRoot)).toBe(false);
  });

  it("rejects a stopped schema-8 Sysbox runner before installer state or Docker and preserves its bytes", async () => {
    // Given: canonical DIM lifecycle state contains a stopped Sysbox runner.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const predecessor = await writeRunnerState(input.stateRoot, sysboxRunner);

    // When: the control-plane installer starts.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      environment: { DIM_STATE_ROOT: predecessor.stateRoot }
    });

    // Then: executor phase does not weaken the refusal and the record remains untouched.
    await expect(action).rejects.toThrow(/Project-scoped CI runner state/);
    expect(runner.calls).toEqual([]);
    expect(await exists(input.stateRoot)).toBe(false);
    expect(await readFile(predecessor.recordPath)).toEqual(predecessor.bytes);
  });

  it("rejects a schema-8 QEMU runner before installer state or Docker and preserves its bytes", async () => {
    // Given: canonical DIM lifecycle state contains predecessor QEMU capacity.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const predecessor = await writeRunnerState(input.stateRoot, qemuRunner);

    // When: the control-plane installer starts.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      environment: { DIM_STATE_ROOT: predecessor.stateRoot }
    });

    // Then: no Project-scoped predecessor is adopted or mutated.
    await expect(action).rejects.toThrow(/Project-scoped CI runner state/);
    expect(runner.calls).toEqual([]);
    expect(await exists(input.stateRoot)).toBe(false);
    expect(await readFile(predecessor.recordPath)).toEqual(predecessor.bytes);
  });

  it("rejects canonical managed-Gitea state before config, installer state, or Docker", async () => {
    // Given: the predecessor managed-Gitea canonical path exists and later inputs are invalid.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const stateRoot = join(dirname(input.stateRoot), "lifecycle");
    const recordPath = join(stateRoot, "services", "gitea.json");
    const bytes = Buffer.from("{\"schemaVersion\":2}\n");
    await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
    await writeFile(recordPath, bytes, { mode: 0o600 });

    // When: installation begins.
    const action = installControlPlane({
      configPath: join(input.stateRoot, "missing-config.json"), stateRoot: input.stateRoot, runner,
      environment: { DIM_STATE_ROOT: stateRoot }
    });

    // Then: the exact canonical record blocks the native cutover without mutation.
    await expect(action).rejects.toThrow(/managed Gitea state/);
    expect(runner.calls).toEqual([]);
    expect(await exists(input.stateRoot)).toBe(false);
    expect(await readFile(recordPath)).toEqual(bytes);
  });

  it.each([
    ["malformed JSON", "{not-json\n"],
    ["unsupported schema", `${JSON.stringify({ ...qemuRunner, schemaVersion: 7 })}\n`],
    ["unknown executor", `${JSON.stringify({ ...qemuRunner, executor: { ...qemuRunner.executor, kind: "future" } })}\n`]
  ])("fails closed for %s in a canonical runner record", async (_case, bytes) => {
    // Given: one canonical record cannot be classified as supported QEMU state.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const predecessor = await writeRunnerBytes(input.stateRoot, bytes);

    // When: installation begins.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      environment: { DIM_STATE_ROOT: predecessor.stateRoot }
    });

    // Then: the record and every later boundary remain unchanged.
    await expect(action).rejects.toThrow(/predecessor.*runner|runner.*unsupported|runner.*valid JSON/i);
    expect(runner.calls).toEqual([]);
    expect(await exists(input.stateRoot)).toBe(false);
    expect(await readFile(predecessor.recordPath)).toEqual(predecessor.bytes);
  });

  it("fails closed for a symlinked canonical runner record", async () => {
    // Given: a canonical record pathname is a symbolic link to otherwise valid QEMU bytes.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const stateRoot = join(dirname(input.stateRoot), "lifecycle");
    const projectRoot = join(stateRoot, "ci-runners", "project");
    const external = join(stateRoot, "external.json");
    const recordPath = join(projectRoot, "capacity.json");
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    await writeFile(external, `${JSON.stringify(qemuRunner)}\n`, { mode: 0o600 });
    await symlink(external, recordPath);

    // When: installation begins.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      environment: { DIM_STATE_ROOT: stateRoot }
    });

    // Then: no linked bytes are adopted and no later boundary is touched.
    await expect(action).rejects.toThrow(/runner.*open|runner.*symbolic|runner.*ownership/i);
    expect(runner.calls).toEqual([]);
    expect(await exists(join(input.stateRoot, "install.lock"))).toBe(false);
  });

  it("rejects a canonical runner record without changing its caller-only mode or bytes", async () => {
    // Given: a canonical QEMU record is readable but mode 0644 instead of mode 0600.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const predecessor = await writeRunnerState(input.stateRoot, qemuRunner);
    await chmod(predecessor.recordPath, 0o644);
    const before = await readFile(predecessor.recordPath);

    // When: installation begins.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      environment: { DIM_STATE_ROOT: predecessor.stateRoot }
    });

    // Then: predecessor state fails closed without inspection-driven rewriting.
    await expect(action).rejects.toThrow(/Project-scoped CI runner state/);
    expect(runner.calls).toEqual([]);
    expect(await readFile(predecessor.recordPath)).toEqual(before);
  });
});

async function writeRunnerState(installerRoot: string, value: unknown) {
  return writeRunnerBytes(installerRoot, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeRunnerBytes(installerRoot: string, contents: string) {
  const stateRoot = join(dirname(installerRoot), "lifecycle");
  const projectRoot = join(stateRoot, "ci-runners", "project");
  const recordPath = join(projectRoot, "capacity.json");
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await writeFile(recordPath, contents, { mode: 0o600 });
  return { stateRoot, recordPath, bytes: await readFile(recordPath) };
}

const commonRunner = {
  schemaVersion: 8,
  name: "capacity",
  projectId: "project-id",
  projectName: "project",
  provider: "pending",
  config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z"
} as const;

const sysboxRunner = {
  ...commonRunner,
  executor: {
    kind: "sysbox", phase: "stopped", containerName: "dim-runner", volumeName: "dim-runner-data",
    image: "example.invalid/runner@sha256:abc", runtime: "sysbox-runc",
    resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: false,
    labels: ["candidate-controlled"], updatedAt: "2026-10-06T00:00:00.000Z"
  }
} as const;

const qemuRunner = {
  ...commonRunner,
  executor: {
    kind: "qemu", phase: "ready", supervisorName: "dim-qemu", volumeName: "dim-qemu-data",
    image: "example.invalid/supervisor@sha256:def", jobImage: "example.invalid/job@sha256:123",
    projectHook: { sourceRef: "refs/heads/main", sourceCommit: "c".repeat(40), kind: "present", digest: "d".repeat(64) },
    resources: { cpus: "4", memory: "8g" }, inheritsResources: false,
    labels: ["candidate-controlled"], updatedAt: "2026-10-06T00:00:00.000Z"
  }
} as const;
