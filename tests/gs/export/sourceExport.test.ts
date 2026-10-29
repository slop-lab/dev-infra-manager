import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createGitFixture, git, runExporter } from "./fixture.ts";

it("exports the selected GS tree and binds every artifact to original Git objects", async () => {
  // Given
  const fixture = await createGitFixture();
  const output = join(fixture.root, "export");
  try {
    // When
    const result = await runExporter(fixture.repository, fixture.selectedCommit, output);

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(output, "source/lib/current.txt"), "utf8")).toBe("prior content\n");
    expect(await readFile(join(output, "source/app/bin/run.sh"), "utf8")).toContain("héllo");
    expect((await lstat(join(output, "source/app/bin/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(output, "source/app/current"))).toBe("../lib/current.txt");
    expect(await readlink(join(output, "source/latest"))).toBe("lib/current.txt");
    expect(await readlink(join(output, "source/generated"))).toBe("dist/generated.js");
    const manifest: unknown = JSON.parse(await readFile(join(output, "export-manifest.json"), "utf8"));
    const tree = await git(fixture.repository, ["rev-parse", `${fixture.selectedCommit}^{tree}`]);
    const lockBlob = await git(fixture.repository, ["rev-parse", `${fixture.selectedCommit}:pnpm-lock.yaml`]);
    const scriptBlob = await git(fixture.repository, ["rev-parse", `${fixture.selectedCommit}:packages/gs/app/bin/run.sh`]);
    const scriptContent = await readFile(join(output, "source/app/bin/run.sh"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      source: { commit: fixture.selectedCommit, tree, prefix: "packages/gs/" },
      bundle: { path: "source-history.bundle", ref: "refs/heads/source-commit" },
      monorepoLock: { sourcePath: "pnpm-lock.yaml", blobId: lockBlob },
      packages: [
        { name: "@this-project/gs-workspace", exportPath: "." },
        { name: "@slop-lab/gs-app", exportPath: "app" },
        { name: "@slop-lab/gs-lib", exportPath: "lib" },
      ],
      dependencies: [
        { from: "@slop-lab/gs-app", name: "@slop-lab/gs-lib", kind: "dependencies", specifier: "workspace:1.0.0", target: "@slop-lab/gs-lib" },
        { from: "@slop-lab/gs-lib", name: "zod", kind: "dependencies", specifier: "4.6.6" },
      ],
    });
    expect(manifest).toHaveProperty("files", expect.arrayContaining([{
      sourcePath: "packages/gs/app/bin/run.sh",
      exportPath: "app/bin/run.sh",
      blobId: scriptBlob,
      mode: "100755",
      sha256: createHash("sha256").update(scriptContent).digest("hex"),
    }]));
    const bundle = await readFile(join(output, "source-history.bundle"));
    expect(manifest).toMatchObject({ bundle: { sha256: createHash("sha256").update(bundle).digest("hex") } });
    await expect(readFile(join(output, "source/untracked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("recovers prior selected ancestry from the bundle without unrelated branch refs", async () => {
  // Given
  const fixture = await createGitFixture();
  const output = join(fixture.root, "export");
  const clone = join(fixture.root, "clone");
  try {
    await runExporter(fixture.repository, fixture.selectedCommit, output);

    // When
    await git(fixture.root, ["clone", "--branch", "source-commit", join(output, "source-history.bundle"), clone]);

    // Then
    expect(await git(clone, ["rev-parse", "refs/heads/source-commit"])).toBe(fixture.selectedCommit);
    expect(await git(clone, ["show", `${fixture.priorCommit}:packages/gs/lib/old.txt`])).toBe("prior content");
    await expect(git(clone, ["cat-file", "-e", `${fixture.unrelatedCommit}^{commit}`])).rejects.toBeDefined();
    expect(await git(clone, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).toBe("refs/heads/source-commit");
    await git(fixture.repository, ["bundle", "verify", join(output, "source-history.bundle")]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("exports a selected full SHA-256 commit without translating object identities", async () => {
  // Given
  const fixture = await createGitFixture("sha256");
  const output = join(fixture.root, "sha256-export");
  try {
    // When
    const result = await runExporter(fixture.repository, fixture.selectedCommit, output);

    // Then
    expect(result.status, result.stderr).toBe(0);
    const manifest: unknown = JSON.parse(await readFile(join(output, "export-manifest.json"), "utf8"));
    expect(fixture.selectedCommit).toHaveLength(64);
    expect(manifest).toMatchObject({ source: { commit: fixture.selectedCommit, objectFormat: "sha256" } });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("ignores ambient Git repository and config overrides for the explicit source", async () => {
  // Given
  const fixture = await createGitFixture();
  const output = join(fixture.root, "poisoned-environment-export");
  const poison = join(fixture.root, "poison");
  await mkdir(poison);
  await writeFile(join(poison, "marker"), "unchanged\n");
  const headBefore = await readFile(join(fixture.repository, ".git/HEAD"));
  const refBefore = await readFile(join(fixture.repository, ".git/refs/heads/main"));
  const indexBefore = await readFile(join(fixture.repository, ".git/index"));
  try {
    // When
    const result = await runExporter(fixture.repository, fixture.selectedCommit, output, {
      GIT_DIR: join(poison, "git-dir"),
      GIT_WORK_TREE: join(poison, "work-tree"),
      GIT_INDEX_FILE: join(poison, "index"),
      GIT_COMMON_DIR: join(poison, "common"),
      GIT_OBJECT_DIRECTORY: join(poison, "objects"),
      GIT_NAMESPACE: "poisoned",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    });

    // Then
    expect(result.status, result.stderr).toBe(0);
    const manifest: unknown = JSON.parse(await readFile(join(output, "export-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ source: { commit: fixture.selectedCommit } });
    expect(await readFile(join(fixture.repository, ".git/HEAD"))).toEqual(headBefore);
    expect(await readFile(join(fixture.repository, ".git/refs/heads/main"))).toEqual(refBefore);
    expect(await readFile(join(fixture.repository, ".git/index"))).toEqual(indexBefore);
    expect(await readdir(poison)).toEqual(["marker"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
