import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightStateCompatibility } from "../../../../core/packages/core/src/stateCompatibility.js";
import { HOST_PROJECT, HOST_QEMU_RUNNER, workspaceRecord } from "./hostLifecycleFixture.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-state-compatibility-"));
  roots.push(root);
  return root;
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installation state compatibility preflight", () => {
  it("accepts missing state without creating the default state root", async () => {
    // Given
    const home = await temporaryRoot();
    const stateRoot = join(home, ".local", "state", "dim");

    // When
    const result = await preflightStateCompatibility({ HOME: home });

    // Then
    expect(result).toEqual({ stateRoot, warnings: [] });
    await expect(readdir(join(home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts current known families and ignores plugin-private state", async () => {
    // Given
    const stateRoot = await temporaryRoot();
    await writeJson(join(stateRoot, "host.json"), {
      schemaVersion: 2,
      phase: "ready",
      resumeWorkspaces: [],
      restartCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: "now"
    });
    await writeJson(join(stateRoot, "projects", "example.json"), HOST_PROJECT);
    await writeJson(join(stateRoot, "workspaces", "work-1.json"), workspaceRecord("work-1", "ready"));
    await writeJson(join(stateRoot, "ci-runners", "example", "capacity.json"), HOST_QEMU_RUNNER);
    await writeJson(join(stateRoot, "plugins", "future-plugin", "private.json"), { schemaVersion: 999 });

    // When
    const result = await preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot });

    // Then
    expect(result).toEqual({ stateRoot, warnings: [] });
  });

  it("accepts the exact historical host record without changing its bytes", async () => {
    // Given
    const stateRoot = await temporaryRoot();
    const target = join(stateRoot, "host.json");
    const bytes = `${JSON.stringify({
      schemaVersion: 1,
      phase: "stopped",
      resumeWorkspaces: ["work-1"],
      resumeCiRunners: [{ project: "example", name: "capacity" }],
      resumeManagedContainers: [],
      updatedAt: "before-upgrade"
    }, null, 2)}\n`;
    await writeFile(target, bytes);

    // When
    const result = await preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot });

    // Then
    expect(result.warnings).toHaveLength(1);
    expect(await readFile(target, "utf8")).toBe(bytes);
    expect(await readdir(stateRoot)).toEqual(["host.json"]);
  });

  it("rejects unsupported workspace state with path and recovery guidance without mutation", async () => {
    // Given
    const stateRoot = await temporaryRoot();
    const target = join(stateRoot, "workspaces", "work-1.json");
    const bytes = `${JSON.stringify({ ...workspaceRecord("work-1", "ready"), schemaVersion: 5 })}\n`;
    await writeJson(target, JSON.parse(bytes));
    const before = await readFile(target);

    // When
    const preflight = preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot });

    // Then
    await expect(preflight).rejects.toThrow(/workspace.*work-1\.json.*schema 5.*pinned DIM version.*export.*recreate/is);
    expect(await readFile(target)).toEqual(before);
    expect(await readdir(stateRoot)).toEqual(["workspaces"]);
  });

  it("rejects malformed project JSON without disclosing its contents", async () => {
    // Given
    const stateRoot = await temporaryRoot();
    const target = join(stateRoot, "projects", "secret.json");
    await mkdir(join(stateRoot, "projects"));
    await writeFile(target, "{not-json:super-secret-token\n");

    // When
    const preflight = preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot });

    // Then
    await expect(preflight).rejects.toThrow(/project.*secret\.json.*valid JSON/is);
    await expect(preflight).rejects.not.toThrow(/super-secret-token/);
  });

  it("rejects symlinked known state files at the untrusted boundary", async () => {
    // Given
    const stateRoot = await temporaryRoot();
    const external = join(stateRoot, "external.json");
    const target = join(stateRoot, "workspaces", "work-1.json");
    await writeFile(external, `${JSON.stringify(workspaceRecord("work-1", "ready"))}\n`);
    await mkdir(join(stateRoot, "workspaces"));
    await symlink(external, target);

    // When
    const preflight = preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot });

    // Then
    await expect(preflight).rejects.toThrow(/workspace.*regular file.*symlink/is);
  });
});
