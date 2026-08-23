import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("DIM development forge policy", () => {
  it("protects development and promotes managed main only to canonical development", async () => {
    const manifest = parse(await readFile(resolve(repositoryRoot, ".dim/repos.yml"), "utf8"));
    const root = manifest?.repositories?.dim;

    expect(manifest?.schemaVersion).toBe(1);
    expect(root?.root).toBe(true);
    expect(root?.ref).toBe("development");
    expect(root?.protect).toEqual(expect.arrayContaining(["development", "main"]));
    expect(root?.protect).toHaveLength(2);
    expect(root?.publish).toEqual({ main: "development" });
  });

  it("reserves disposable QEMU gates for non-draft promotions to managed main", async () => {
    const workflow = parse(await readFile(resolve(repositoryRoot, ".gitea/workflows/ci.yml"), "utf8"));
    const condition = String(workflow?.jobs?.["host-backend"]?.if ?? "");

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("github.event.pull_request.draft == false");
    expect(workflow?.jobs?.["source-compatibility"]?.if).toBeUndefined();
    expect(workflow?.jobs?.["workspace-integration"]?.if).toBeUndefined();
  });
});
