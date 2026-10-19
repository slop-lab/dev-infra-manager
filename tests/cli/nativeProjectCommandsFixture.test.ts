import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { cleanupNativeProjectFixtures, nativeFixture } from "./nativeProjectCommandsFixture.js";

const externalRoots: string[] = [];
const run = promisify(execFile);

afterEach(async () => {
  await cleanupNativeProjectFixtures();
  await Promise.all(externalRoots.splice(0).map(async (root) => {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }));
});

test("native fixture combines an injected workspace lease clock with offsets across restarts", async () => {
  // Given
  let now = 1_000;
  const fixture = await nativeFixture({ workspaceWriteLeaseClock: () => now });

  // When
  now = 2_000;
  fixture.advanceLeaseClock(300);
  await fixture.restartNativeGit();
  await fixture.rolloverNativeGit();

  // Then
  assert.equal(fixture.leaseClock(), 2_300);
});

test("native fixture cleanup repairs only owned directories below its registered temporary root", async () => {
  // Given
  const fixture = await nativeFixture();
  const root = dirname(fixture.serviceRoot);
  const readonlyDirectory = join(root, "readonly", "nested");
  const externalRoot = await mkdtemp("/tmp/dim-native-external-");
  externalRoots.push(externalRoot);
  await mkdir(readonlyDirectory, { recursive: true });
  await writeFile(join(readonlyDirectory, "asset"), "readonly\n");
  await chmod(readonlyDirectory, 0o500);
  await chmod(dirname(readonlyDirectory), 0o500);
  await chmod(externalRoot, 0o500);
  await symlink(externalRoot, join(root, "external"));

  // When
  await cleanupNativeProjectFixtures();

  // Then
  await assert.rejects(access(root), { code: "ENOENT" });
  assert.equal((await stat(externalRoot)).mode & 0o777, 0o500);
});

for (const mask of [0o002, 0o000]) {
  test(`native root import keeps Git storage private under umask ${mask.toString(8)}`, async () => {
    // Given
    const previous = process.umask(mask);
    try {
      // When
      const fixture = await nativeFixture();

      // Then
      const repository = join(fixture.serviceRoot, "project-a", "root.git");
      const shared = await run("/usr/bin/git", ["--git-dir", repository, "config", "--get", "core.sharedRepository"]);
      assert.equal(shared.stdout.trim(), "0600");
      for (const relative of ["", "objects", "objects/pack", "refs", "refs/heads", "refs/heads/main"]) {
        assert.equal((await stat(join(repository, relative))).mode & 0o077, 0, relative);
      }
      for (const name of await readdir(join(repository, "objects", "pack"))) {
        assert.equal((await stat(join(repository, "objects", "pack", name))).mode & 0o077, 0, name);
      }
    } finally {
      process.umask(previous);
    }
  });
}
