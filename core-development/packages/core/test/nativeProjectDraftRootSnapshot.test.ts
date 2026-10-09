import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, readdir, stat, symlink, truncate, unlink,
  writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  LifecycleState,
  materializeNativeProjectDraftRootSnapshot
} from "../../../../core/packages/core/src/index.js";
import {
  cleanupNativeProjectDraftRootReadFixtures,
  nativeProjectDraftRootReadFixture
} from "./nativeProjectDraftRootReadFixture.js";
import { rootRepository } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { descendantCommit, seedRootPromotion } from "../../native-git/test/nativeCurrentRootProofFixture.js";

afterEach(cleanupNativeProjectDraftRootReadFixtures);
const run = promisify(execFile);

describe("native Project draft root snapshots", () => {
  it("materializes the exact imported root with safe links and no authority or runnable state", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture(undefined, async (source) => {
      await mkdir(join(source, "docs"));
      await writeFile(join(source, "docs", "guide.md"), "reviewed guide\n");
      await writeFile(join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
      await chmod(join(source, "run.sh"), 0o755);
      await symlink("docs/guide.md", join(source, "guide-link"));
    });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });

    // When
    const snapshot = await materializeNativeProjectDraftRootSnapshot({
      stateRoot: fixture.root,
      name: "acme",
      importerConnectionFile: fixture.importerConnectionFile,
      issuerConnectionFile: fixture.issuerConnectionFile,
      gitExecutable: "/usr/bin/git",
      temporaryRoot,
      signal: AbortSignal.timeout(20_000)
    });

    // Then
    expect(snapshot).toEqual({ projectId: "project-a", rootRepositoryId: "root",
      rootAlias: fixture.draft.rootAlias, protectedRef: fixture.draft.protectedRef,
      rootCommit: fixture.draft.expectedCommit, rootTree: fixture.draft.expectedTree,
      rootSnapshotPath: join(fixture.root, "assets", "native-project-roots", "project-a",
        fixture.draft.expectedCommit) });
    expect(await readFile(join(snapshot.rootSnapshotPath, "README.md"), "utf8"))
      .toBe("trusted imported root\n");
    expect(await readlink(join(snapshot.rootSnapshotPath, "guide-link"))).toBe("docs/guide.md");
    expect((await stat(join(snapshot.rootSnapshotPath, "run.sh"))).mode & 0o777).toBe(0o555);
    expect((await stat(join(snapshot.rootSnapshotPath, "README.md"))).mode & 0o777).toBe(0o444);
    await expect(lstat(join(snapshot.rootSnapshotPath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(snapshot.rootSnapshotPath)).join("\n"))
      .not.toContain("root-read-");
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect(await readdir(join(fixture.root, "assets", "native-project-roots", "project-a")))
      .toEqual([fixture.draft.expectedCommit]);
    expect(await new LifecycleState(fixture.root).listProjects()).toEqual([]);
  });

  it("withholds the original imported draft snapshot after an unattested promotion", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture();
    if (fixture.draft.phase !== "root-imported") throw new Error("fixture did not import root");
    const promoted = await descendantCommit(fixture.serviceRoot, fixture.draft.expectedTree,
      fixture.draft.expectedCommit);
    await seedRootPromotion({ root: fixture.serviceRoot, candidateCommit: promoted,
      candidateTree: fixture.draft.expectedTree });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });

    // When
    const snapshot = materializeNativeProjectDraftRootSnapshot(snapshotInput(fixture, temporaryRoot));

    // Then
    await expect(snapshot).rejects.toThrow();
    await expect(lstat(snapshotTarget(fixture))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(fixture.serviceRoot),
      "rev-parse", fixture.draft.protectedRef])).stdout.trim()).toBe(promoted);
  });

  it("fetches the protected root without forcing a ref update", async () => {
    // Given: Git rejects and records any forced fetch rather than delegating it.
    const fixture = await nativeProjectDraftRootReadFixture();
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const marker = join(fixture.root, "forced-fetch");
    const executable = join(fixture.root, "nonforcing-git");
    await writeFile(marker, "", { mode: 0o600 });
    await writeFile(executable, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = '--force' ]; then
    printf 'force' > ${JSON.stringify(marker)}
    exit 41
  fi
done
exec /usr/bin/git "$@"
`, { mode: 0o700 });

    // When: the host materializes the real imported root using that executable.
    const result = await materializeNativeProjectDraftRootSnapshot({
      ...snapshotInput(fixture, temporaryRoot), gitExecutable: executable
    }).then(() => "published", () => "failed");

    // Then: no force flag reaches Git, and the exact snapshot is published.
    expect(await readFile(marker, "utf8")).toBe("");
    expect(result).toBe("published");
    expect(await readFile(join(snapshotTarget(fixture), "README.md"), "utf8"))
      .toBe("trusted imported root\n");
  });

  it("refuses an unsafe existing target without adopting or rewriting it", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture();
    const target = join(fixture.root, "assets", "native-project-roots", "project-a",
      fixture.draft.expectedCommit);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(join(target, "foreign"), "keep\n");
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });

    // When / Then
    await expect(materializeNativeProjectDraftRootSnapshot({ stateRoot: fixture.root, name: "acme",
      importerConnectionFile: fixture.importerConnectionFile,
      issuerConnectionFile: fixture.issuerConnectionFile, gitExecutable: "/usr/bin/git",
      temporaryRoot, signal: AbortSignal.timeout(20_000) })).rejects.toThrow();
    expect(await readFile(join(target, "foreign"), "utf8")).toBe("keep\n");
  });

  it("withholds publication when the protected ref moves during lease-backed Git verification", async () => {
    // Given: the service pauses the first Git read after issuing a root lease.
    let releaseVerification: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseVerification = resolve; });
    let announceVerification: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { announceVerification = resolve; });
    let verifications = 0;
    const fixture = await nativeProjectDraftRootReadFixture({ beforeVerification: async () => {
      verifications += 1;
      if (verifications !== 2) return;
      announceVerification?.();
      await blocked;
    } });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const action = materializeNativeProjectDraftRootSnapshot(snapshotInput(fixture, temporaryRoot));
    await Promise.race([entered, action.then(() => { throw new Error("Git read was not held"); })]);
    const repository = rootRepository(fixture.serviceRoot);
    const moved = (await run("/usr/bin/git", ["--git-dir", repository,
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
      "commit-tree", fixture.draft.expectedTree, "-m", "moved root"])).stdout.trim();
    await run("/usr/bin/git", ["--git-dir", repository, "update-ref",
      fixture.draft.protectedRef, moved, fixture.draft.expectedCommit]);

    // When: the paused transport rechecks the live protected root.
    releaseVerification?.();

    // Then: no commit snapshot or unpublished stage survives the stale proof.
    await expect(action).rejects.toThrow();
    await expect(lstat(snapshotTarget(fixture))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(fixture.root, "assets", "native-project-roots", fixture.draft.projectId)))
      .toEqual([]);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("reuses a recursively valid cache without minting another root-read lease", async () => {
    // Given
    let leaseVerifications = 0;
    const fixture = await nativeProjectDraftRootReadFixture({ beforeVerification: async () => {
      leaseVerifications += 1;
    } });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const input = snapshotInput(fixture, temporaryRoot);
    const first = await materializeNativeProjectDraftRootSnapshot(input);
    const afterFirst = leaseVerifications;

    // When
    const second = await materializeNativeProjectDraftRootSnapshot(input);

    // Then
    expect(second).toEqual(first);
    expect(leaseVerifications).toBe(afterFirst);
  });

  it("refuses cached root bytes changed after publication even when modes are restored", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture();
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const input = snapshotInput(fixture, temporaryRoot);
    const snapshot = await materializeNativeProjectDraftRootSnapshot(input);
    const cachedFile = join(snapshot.rootSnapshotPath, "README.md");
    await chmod(cachedFile, 0o600);
    await writeFile(cachedFile, "altered imported bytes\n");
    await chmod(cachedFile, 0o444);

    // When
    const reused = materializeNativeProjectDraftRootSnapshot(input);

    // Then
    await expect(reused).rejects.toThrow();
    expect(await readFile(cachedFile, "utf8")).toBe("altered imported bytes\n");
  });

  it("refuses a cached executable changed to a safe non-executable mode", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture(undefined, async (source) => {
      await writeFile(join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
      await chmod(join(source, "run.sh"), 0o755);
    });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const input = snapshotInput(fixture, temporaryRoot);
    const snapshot = await materializeNativeProjectDraftRootSnapshot(input);
    const cachedFile = join(snapshot.rootSnapshotPath, "run.sh");
    await chmod(cachedFile, 0o444);

    // When / Then
    await expect(materializeNativeProjectDraftRootSnapshot(input)).rejects.toThrow();
    expect((await lstat(cachedFile)).mode & 0o777).toBe(0o444);
  });

  it("refuses a cached symbolic link changed to another contained target", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture(undefined, async (source) => {
      await writeFile(join(source, "other.txt"), "other\n");
      await symlink("README.md", join(source, "guide-link"));
    });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const input = snapshotInput(fixture, temporaryRoot);
    const snapshot = await materializeNativeProjectDraftRootSnapshot(input);
    const cachedLink = join(snapshot.rootSnapshotPath, "guide-link");
    await chmod(snapshot.rootSnapshotPath, 0o755);
    await unlink(cachedLink);
    await symlink("other.txt", cachedLink);
    await chmod(snapshot.rootSnapshotPath, 0o555);

    // When / Then
    await expect(materializeNativeProjectDraftRootSnapshot(input)).rejects.toThrow();
    expect(await readlink(cachedLink)).toBe("other.txt");
  });

  it.each([
    ["reserved", ".dim/setup.sh", "../README.md"],
    ["absolute", "absolute-link", "/etc/passwd"],
    ["dangling", "dangling-link", "missing"],
    ["escaping", "escaping-link", "../outside"]
  ] as const)("refuses a %s symbolic link without publishing", async (_case, linkPath, target) => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture(undefined, async (source) => {
      if (linkPath === ".dim/setup.sh") {
        await writeFile(join(source, ".dim", "target"), "target\n");
        await symlink(target, join(source, linkPath));
      } else {
        await symlink(target, join(source, linkPath));
      }
    });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });

    // When / Then
    await expect(materializeNativeProjectDraftRootSnapshot(snapshotInput(fixture, temporaryRoot)))
      .rejects.toThrow();
    await expect(lstat(snapshotTarget(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a gitlink without publishing", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture(undefined, undefined, async (source) => {
      await run("/usr/bin/git", ["-C", source, "update-index", "--add", "--cacheinfo",
        `160000,${"a".repeat(40)},vendor`]);
    });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });

    // When / Then
    await expect(materializeNativeProjectDraftRootSnapshot(snapshotInput(fixture, temporaryRoot)))
      .rejects.toThrow();
    await expect(lstat(snapshotTarget(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an oversized blob without publishing", async () => {
    // Given
    const fixture = await nativeProjectDraftRootReadFixture(undefined, async (source) => {
      await writeFile(join(source, "oversized.bin"), "");
      await truncate(join(source, "oversized.bin"), 16 * 1024 * 1024 + 1);
    });
    const temporaryRoot = join(fixture.root, "snapshot-temporary");
    await mkdir(temporaryRoot, { mode: 0o700 });

    // When / Then
    await expect(materializeNativeProjectDraftRootSnapshot(snapshotInput(fixture, temporaryRoot)))
      .rejects.toThrow();
    await expect(lstat(snapshotTarget(fixture))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});

function snapshotInput(fixture: Awaited<ReturnType<typeof nativeProjectDraftRootReadFixture>>,
  temporaryRoot: string) {
  return { stateRoot: fixture.root, name: "acme", importerConnectionFile: fixture.importerConnectionFile,
    issuerConnectionFile: fixture.issuerConnectionFile, gitExecutable: "/usr/bin/git", temporaryRoot,
    signal: AbortSignal.timeout(20_000) };
}

function snapshotTarget(fixture: Awaited<ReturnType<typeof nativeProjectDraftRootReadFixture>>): string {
  return join(fixture.root, "assets", "native-project-roots", fixture.draft.projectId,
    fixture.draft.expectedCommit);
}
