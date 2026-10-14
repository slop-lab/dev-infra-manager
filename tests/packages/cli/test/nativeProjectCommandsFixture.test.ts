import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanupNativeProjectFixtures, nativeFixture } from "./nativeProjectCommandsFixture.js";

const externalRoots: string[] = [];

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
