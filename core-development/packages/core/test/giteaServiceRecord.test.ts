import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed Gitea service state", () => {
  it("rejects obsolete state without runtime mutation or implicit adoption", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-gitea-service-record-"));
    cleanup.push(root);
    const state = new LifecycleState(root);
    const obsolete = `${JSON.stringify({
      phase: "ready",
      containerName: "dim-gitea",
      networkName: "dim-control",
      volumeName: "dim-gitea-data",
      image: "gitea/gitea:1.27.0",
      port: 3300,
      createdAt: "before",
      updatedAt: "before"
    }, null, 2)}\n`;
    await mkdir(join(root, "services"));
    await writeFile(state.giteaServicePath(), obsolete);

    // When
    const read = state.readGiteaService();

    // Then
    await expect(read).rejects.toThrow(/unsupported state schema/);
    await expect(readFile(state.giteaServicePath(), "utf8")).resolves.toBe(obsolete);
  });
});
