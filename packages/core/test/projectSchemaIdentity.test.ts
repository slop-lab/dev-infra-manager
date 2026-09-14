import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

type RawProject = {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly gitNamespace: string;
  readonly giteaOrganizationId?: number | null;
  readonly phase: "creating" | "ready";
  readonly repositories: readonly [];
  readonly createdAt: string;
  readonly updatedAt: string;
};

function rawProject(
  schemaVersion: number,
  giteaOrganizationId?: number | null,
  phase: RawProject["phase"] = "ready"
): RawProject {
  return {
    schemaVersion,
    id: "project-id",
    name: "example",
    gitNamespace: "dim-example",
    ...(giteaOrganizationId === undefined ? {} : { giteaOrganizationId }),
    phase,
    repositories: [],
    createdAt: "now",
    updatedAt: "now"
  };
}

describe("Project schema organization identity", () => {
  let stateRoot = "";
  let state = new LifecycleState("/uninitialized");

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-project-schema-"));
    state = new LifecycleState(stateRoot);
    await mkdir(join(stateRoot, "projects"), { recursive: true });
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("rejects schema 3 Project state without compatibility adoption", async () => {
    // Given
    await writeFile(state.projectPath("example"), JSON.stringify(rawProject(3)));

    // When
    const read = state.readProject("example");

    // Then
    await expect(read).rejects.toThrow(/unsupported state schema 3.*expected 4/);
  });

  it("rejects ready schema 4 Project state with a null organization ID", async () => {
    // Given
    await writeFile(state.projectPath("example"), JSON.stringify(rawProject(4, null)));

    // When
    const read = state.readProject("example");

    // Then
    await expect(read).rejects.toThrow(/organization.*ID/i);
  });

  it("rejects schema 4 Project state without an organization ID", async () => {
    // Given
    await writeFile(state.projectPath("example"), JSON.stringify(rawProject(4)));

    // When
    const read = state.readProject("example");

    // Then
    await expect(read).rejects.toThrow(/giteaOrganizationId is required/);
  });

  it("accepts a non-ready schema 4 Project state with a null organization ID", async () => {
    // Given
    await writeFile(state.projectPath("example"), JSON.stringify(rawProject(4, null, "creating")));

    // When
    const read = state.readProject("example");

    // Then
    await expect(read).resolves.toMatchObject({ phase: "creating", giteaOrganizationId: null });
  });
});
