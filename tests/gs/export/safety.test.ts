import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commitAll, createGitFixture, git, runExporter } from "./fixture.ts";

it("refuses occupied and source-contained output paths without changing user data", async () => {
  // Given
  const fixture = await createGitFixture();
  const occupied = join(fixture.root, "occupied");
  const marker = join(occupied, "marker.txt");
  await mkdir(occupied);
  await writeFile(marker, "keep\n");
  try {
    // When
    const occupiedResult = await runExporter(fixture.repository, fixture.selectedCommit, occupied);
    const containedResult = await runExporter(fixture.repository, fixture.selectedCommit, join(fixture.repository, "export"));

    // Then
    expect(occupiedResult.status).not.toBe(0);
    expect(containedResult.status).not.toBe(0);
    expect(await readFile(marker, "utf8")).toBe("keep\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("rejects unsafe symlinks and removes only its newly owned output", async () => {
  // Given
  const fixture = await createGitFixture();
  const output = join(fixture.root, "unsafe-export");
  await symlink("../../../outside", join(fixture.repository, "packages/gs/app/escape"));
  const commit = await commitAll(fixture.repository, "unsafe link");
  try {
    // When
    const result = await runExporter(fixture.repository, commit, output);

    // Then
    expect(result.status).not.toBe(0);
    await expect(readFile(join(output, "export-manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("rejects a symlink graph that escapes only after an earlier symlink expansion", async () => {
  // Given
  const fixture = await createGitFixture();
  const output = join(fixture.root, "composed-link-export");
  await mkdir(join(fixture.repository, "packages/gs/subdir"));
  await symlink(".", join(fixture.repository, "packages/gs/a"));
  await symlink("../a/../export-manifest.json", join(fixture.repository, "packages/gs/subdir/b"));
  const commit = await commitAll(fixture.repository, "composed escaping link");
  const refBefore = await readFile(join(fixture.repository, ".git/refs/heads/main"));
  const indexBefore = await readFile(join(fixture.repository, ".git/index"));
  try {
    // When
    const result = await runExporter(fixture.repository, commit, output);

    // Then
    expect(result.status).not.toBe(0);
    await expect(readFile(join(output, "source/subdir/b"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(fixture.repository, ".git/refs/heads/main"))).toEqual(refBefore);
    expect(await readFile(join(fixture.repository, ".git/index"))).toEqual(indexBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("requires a full object ID from a non-shallow source repository", async () => {
  // Given
  const fixture = await createGitFixture();
  const shortOutput = join(fixture.root, "short-export");
  const shallow = join(fixture.root, "shallow");
  await git(fixture.root, ["clone", "--depth=1", `file://${fixture.repository}`, shallow]);
  const shallowCommit = await git(shallow, ["rev-parse", "HEAD"]);
  try {
    // When
    const shortResult = await runExporter(fixture.repository, fixture.selectedCommit.slice(0, 12), shortOutput);
    const shallowResult = await runExporter(shallow, shallowCommit, join(fixture.root, "shallow-export"));

    // Then
    expect(shortResult.status).not.toBe(0);
    expect(shallowResult.status).not.toBe(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it.each([
  { dependency: "@slop-lab/dim-host-core", specifier: "workspace:1.0.0" },
  { dependency: "@slop-lab/gs-missing", specifier: "workspace:1.0.0" },
])("rejects a package graph that is not closed within the selected GS tree", async ({ dependency, specifier }) => {
  // Given
  const fixture = await createGitFixture();
  const output = join(fixture.root, "unclosed-export");
  await writeFile(join(fixture.repository, "packages/gs/app/package.json"), JSON.stringify({
    name: "@slop-lab/gs-app",
    private: true,
    dependencies: { [dependency]: specifier },
  }));
  const commit = await commitAll(fixture.repository, "unclosed dependency");
  try {
    // When
    const result = await runExporter(fixture.repository, commit, output);

    // Then
    expect(result.status).not.toBe(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
