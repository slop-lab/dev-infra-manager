import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeProject, PROJECT_COMPOSE_TEMPLATE } from "../src/projectScaffold.js";

describe("project scaffold", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-project-scaffold-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates only the default .dim Compose contract", async () => {
    const target = await initializeProject(root, false);
    expect(target).toBe(join(root, ".dim", "docker-compose.yml"));
    expect(await readFile(target, "utf8")).toBe(PROJECT_COMPOSE_TEMPLATE);
  });

  it("preserves an existing scaffold unless force is explicit", async () => {
    const target = await initializeProject(root, false);
    await writeFile(target, "services: {}\n");
    await expect(initializeProject(root, false)).rejects.toThrow(/--force/);
    expect(await readFile(target, "utf8")).toBe("services: {}\n");
    await initializeProject(root, true);
    expect(await readFile(target, "utf8")).toBe(PROJECT_COMPOSE_TEMPLATE);
  });
});
