import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitRootImporterClient, prepareNativeRootBootstrapGit
} from "../../../../core/packages/core/src/index.js";
import { activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot, generationId,
  importer, projectInput, rootRepository, startFinalizeService
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
const roots: string[] = [];
const gitExecutable = "/usr/bin/git";
const review = { requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: [
  { name: "source", kind: "ordinary-sysbox" }, { name: "integration", kind: "qemu" }
] } as const;

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(args: readonly string[]): Promise<string> {
  return (await run(gitExecutable, [...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  })).stdout.trim();
}

async function fixture(withManifest: boolean): Promise<{ readonly source: string; readonly scratch: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-bootstrap-"));
  roots.push(root);
  const source = join(root, "source");
  const scratch = join(root, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  await git(["init", "--initial-branch=main", source]);
  if (withManifest) {
    await mkdir(join(source, ".dim"));
    await writeFile(join(source, ".dim/repos.yml"), `schemaVersion: 1
repositories:
  root: {url: https://example.test/root.git, root: true, ref: main, protect: [main]}
nativeReview:
  requiredReviewerIds: [owner]
  pathReviewerRules: []
  requiredJobs:
    - {name: source, kind: ordinary-sysbox}
    - {name: integration, kind: qemu}
`);
  }
  await writeFile(join(source, "README.md"), "pinned root\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
    "commit", "-m", "initial"]);
  return { source, scratch };
}

describe("native root bootstrap Git plan", () => {
  it("derives policy and a self-contained one-ref bundle from one pinned commit across source movement", async () => {
    const { source, scratch } = await fixture(true);
    const commit = await git(["-C", source, "rev-parse", "HEAD"]);
    const tree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
    const plan = await prepareNativeRootBootstrapGit({ gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "reviewed-manifest" }, signal: AbortSignal.timeout(20_000) });
    expect(plan).toMatchObject({ expectedCommit: commit, resolvedTree: tree,
      protectedRef: "refs/heads/main", rootAlias: "root" });
    expect(plan.reviewPolicy.requiredJobs.map(({ name }) => name)).toEqual(["integration", "source"]);
    expect((await stat(plan.bundlePath)).mode & 0o777).toBe(0o600);

    await writeFile(join(source, "README.md"), "moved root\n");
    await git(["-C", source, "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
      "commit", "-am", "moved"]);
    expect(await git(["bundle", "list-heads", plan.bundlePath])).toBe(`${commit} refs/heads/main`);
    const verify = join(scratch, "verify.git");
    await git(["init", "--bare", verify]);
    await git(["--git-dir", verify, "bundle", "verify", plan.bundlePath]);
    await plan.cleanup();
    expect((await readdir(scratch)).sort()).toEqual(["verify.git"]);
  });

  it("supports explicit manifest-free policy and removes staging on invalid reviewed input", async () => {
    const { source, scratch } = await fixture(false);
    await expect(prepareNativeRootBootstrapGit({ gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "reviewed-manifest" }, signal: AbortSignal.timeout(20_000) })).rejects.toThrow();
    expect(await readdir(scratch)).toEqual([]);
    const plan = await prepareNativeRootBootstrapGit({ gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "manifest-free", rootAlias: "root", review },
      signal: AbortSignal.timeout(20_000) });
    expect(plan.reviewPolicy.requiredJobs.map(({ name }) => name)).toEqual(["integration", "source"]);
    await plan.cleanup();
    expect(await readdir(scratch)).toEqual([]);
  });

  it("imports the planned commit and canonical policy through the real service without Git transport", async () => {
    const { source, scratch } = await fixture(true);
    const plan = await prepareNativeRootBootstrapGit({ gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "reviewed-manifest" }, signal: AbortSignal.timeout(20_000) });
    const state = await createFinalizeRoot("planned-import");
    const service = await startFinalizeService(state);
    await activateFinalizeService(service.origin);
    await service.prepareProject(generationId, importer.hostId, projectInput("project-a"));
    const connectionPath = join(scratch, "importer.json");
    await writeFile(connectionPath, JSON.stringify({ schemaVersion: 1, endpoint: service.origin,
      serviceId: "native-main", role: "operator-root-importer", hostId: importer.hostId, generationId,
      credential: { username: importer.username, password: importer.password } }), { mode: 0o600 });
    const client = await createNodeNativeGitRootImporterClient(connectionPath);

    const imported = await client.importRoot({ serviceId: "native-main", projectId: "project-a",
      rootRepositoryId: "root", protectedRef: plan.protectedRef, expectedCommit: plan.expectedCommit,
      policy: plan.reviewPolicy, bundlePath: plan.bundlePath }, AbortSignal.timeout(20_000));

    expect(imported).toMatchObject({ phase: "root-imported", expectedCommit: plan.expectedCommit,
      resolvedTree: plan.resolvedTree });
    expect(imported.policyDigest).toBe(createHash("sha256").update(JSON.stringify(plan.reviewPolicy)).digest("hex"));
    expect(await git(["--git-dir", rootRepository(state), "show-ref", "--hash", "refs/heads/main"]))
      .toBe(plan.expectedCommit);
    const transport = await fetch(`${service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`);
    expect(transport.status).toBe(401);
    await plan.cleanup();
  });
});
