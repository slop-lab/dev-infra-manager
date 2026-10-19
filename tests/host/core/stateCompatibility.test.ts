import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightStateCompatibility } from "../../../packages/host/core/src/stateCompatibility.js";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import type { WorkspaceRecord } from "../../../packages/host/core/src/workspace/models.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-base-state-")); roots.push(root); return root;
}
function currentWorkspace(): WorkspaceRecord {
  return {
    schemaVersion: 10, id: "11111111-1111-4111-8111-111111111111", name: "dev",
    source: { url: "https://example.test/app.git", ref: "refs/heads/main", commit: "a".repeat(40) },
    runtime: "container", image: "dim-workspace:test", initialized: true,
    resources: { cpuCount: "2", memory: "4g", pidsLimit: "2048" },
    git: { name: "Developer", email: "developer@example.test" }, phase: "running",
    createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z"
  };
}

describe("base installation state preflight", () => {
  it("accepts an uninitialized host without creating directories", async () => {
    const home = await temporaryRoot();
    const stateRoot = join(home, ".local", "state", "dim");
    expect(await preflightStateCompatibility({ HOME: home })).toEqual({ stateRoot, warnings: [] });
    expect(await readdir(home)).toEqual([]);
  });

  it("accepts actual current workspace store records while leaving optional feature state alone", async () => {
    const stateRoot = await temporaryRoot();
    await new WorkspaceStore(stateRoot).write(currentWorkspace());
    await writeFile(join(stateRoot, "host.json"), "managed-host-state-owned-elsewhere\n");
    await mkdir(join(stateRoot, "projects"));
    await writeFile(join(stateRoot, "projects", "managed.json"), "not-base-state\n");
    await mkdir(join(stateRoot, "plugins"));
    expect(await preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot })).toEqual({ stateRoot, warnings: [] });
    expect((await new WorkspaceStore(stateRoot).read("dev")).source.commit).toBe("a".repeat(40));
  });

  it.each([
    { ...currentWorkspace(), schemaVersion: 9 },
    { ...currentWorkspace(), initialized: "yes" },
    { ...currentWorkspace(), source: { ...currentWorkspace().source, commit: "invalid" } },
    { ...currentWorkspace(), name: "other-name" }
  ])("rejects unsupported or malformed workspace records without mutation", async (record) => {
    const stateRoot = await temporaryRoot();
    await mkdir(join(stateRoot, "workspaces"));
    const target = join(stateRoot, "workspaces", "dev.json");
    const bytes = `${JSON.stringify(record)}\n`;
    await writeFile(target, bytes);
    await expect(preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot })).rejects.toThrow(/workspace.*dev\.json.*no state was changed/);
    expect(await readFile(target, "utf8")).toBe(bytes);
    expect(await readdir(stateRoot)).toEqual(["workspaces"]);
  });

  it("rejects malformed JSON without disclosing its contents", async () => {
    const stateRoot = await temporaryRoot();
    await mkdir(join(stateRoot, "workspaces"));
    await writeFile(join(stateRoot, "workspaces", "dev.json"), "{secret-private-token\n");
    const preflight = preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot });
    await expect(preflight).rejects.toThrow(/not valid JSON/);
    await expect(preflight).rejects.not.toThrow(/secret-private-token/);
  });

  it("rejects symlinked workspace state before following the target", async () => {
    const stateRoot = await temporaryRoot();
    const external = join(stateRoot, "external.json");
    await writeFile(external, `${JSON.stringify(currentWorkspace())}\n`);
    await mkdir(join(stateRoot, "workspaces"));
    await symlink(external, join(stateRoot, "workspaces", "dev.json"));
    await expect(preflightStateCompatibility({ DIM_STATE_ROOT: stateRoot })).rejects.toThrow(/regular file.*symlink/);
  });
});
