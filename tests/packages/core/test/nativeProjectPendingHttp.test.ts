import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitRootImporterClient, LifecycleState, NativeProjectDraftStore,
  NativeProjectPendingStore } from "../../../../core/packages/core/src/index.js";
import { compileNativeRootBootstrapPolicy } from "../../../../core/packages/core/src/nativeRootBootstrapPolicy.js";
import { activateFinalizeService, cleanupFinalizeFixtures, generationId, importer,
  projectInput, startFinalizeService } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
const roots: string[] = [];
const policy = compileNativeRootBootstrapPolicy({ rootAlias: "root", protectedRef: "refs/heads/main",
  review: { requiredReviewerIds: ["owner"], pathReviewerRules: [],
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox" }] } });

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Project admission through native Git HTTP", () => {
  it("imports a real root and publishes pending state without changing service or draft evidence", async () => {
    // Given
    const fixtureRoot = await mkdtemp("/tmp/dim-native-pending-http-");
    roots.push(fixtureRoot);
    const serviceRoot = join(fixtureRoot, "service");
    const stateRoot = join(fixtureRoot, "host-state");
    const source = join(fixtureRoot, "source");
    const bundlePath = join(fixtureRoot, "root.bundle");
    await mkdir(serviceRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    await run("/usr/bin/git", ["init", "--initial-branch=main", source]);
    await writeFile(join(source, "README.md"), "trusted native root\n");
    await run("/usr/bin/git", ["-C", source, "add", "."]);
    await run("/usr/bin/git", ["-C", source, "-c", "user.name=DIM Test", "-c",
      "user.email=dim@example.invalid", "commit", "-m", "root"]);
    const commit = (await run("/usr/bin/git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    const tree = (await run("/usr/bin/git", ["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    await run("/usr/bin/git", ["-C", source, "bundle", "create", bundlePath, "refs/heads/main"]);
    await chmod(bundlePath, 0o600);
    const service = await startFinalizeService(serviceRoot);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const connectionPath = join(stateRoot, "importer.json");
    await writeFile(connectionPath, JSON.stringify({ schemaVersion: 1, endpoint: service.origin,
      serviceId: "native-main", role: "operator-root-importer", hostId: importer.hostId, generationId,
      credential: { username: importer.username, password: importer.password } }), { mode: 0o600 });
    const client = await createNodeNativeGitRootImporterClient(connectionPath);
    const receipt = await client.importRoot({ serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", protectedRef: policy.protectedRef, expectedCommit: commit,
      policy: policy.reviewPolicy, bundlePath }, AbortSignal.timeout(20_000));
    const drafts = new NativeProjectDraftStore(stateRoot);
    await drafts.claim({ name: "acme", projectId: "project-a", ownerHostId: importer.hostId,
      generationId, expectedCommit: commit, expectedTree: tree, bundlePath, ...policy });
    await drafts.markRootImported("acme", receipt);
    const draftPath = join(stateRoot, "native-project-drafts", "acme.json");
    const draftBefore = await readFile(draftPath);
    const databasePath = join(serviceRoot, "native-idle.sqlite3");
    const databaseBefore = await readFile(databasePath);

    // When
    const record = await new NativeProjectPendingStore(stateRoot)
      .admit("acme", client, AbortSignal.timeout(10_000));
    const projectPath = new LifecycleState(stateRoot).projectPath("acme");
    const projectBytes = await readFile(projectPath);
    const stagingPath = join(stateRoot, "projects",
      ".acme.json.00000000-0000-4000-8000-000000000000.tmp");
    await link(projectPath, stagingPath);
    const beforeReplay = await stat(projectPath, { bigint: true });
    const replay = await new NativeProjectPendingStore(stateRoot)
      .admit("acme", client, AbortSignal.timeout(10_000));
    const afterReplay = await stat(projectPath, { bigint: true });

    // Then
    expect(replay).toEqual(record);
    expect(record).toMatchObject({ schemaVersion: 5, recordType: "native-project",
      phase: "admission-pending", rootCommit: commit, rootTree: tree });
    expect(await readFile(projectPath)).toEqual(projectBytes);
    expect({ ino: afterReplay.ino, mtimeNs: afterReplay.mtimeNs })
      .toEqual({ ino: beforeReplay.ino, mtimeNs: beforeReplay.mtimeNs });
    expect({ beforeLinks: beforeReplay.nlink, afterLinks: afterReplay.nlink })
      .toEqual({ beforeLinks: 2n, afterLinks: 1n });
    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(projectPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(draftPath)).toEqual(draftBefore);
    expect(await readFile(databasePath)).toEqual(databaseBefore);
  });
});
