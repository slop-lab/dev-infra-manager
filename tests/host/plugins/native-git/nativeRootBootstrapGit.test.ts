import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitRootImporterClient, prepareNativeRootBootstrapGit } from "@slop-lab/dim-host-plugin-native-git";
import { activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot, generationId,
  importer, projectInput, rootRepository, startFinalizeService
} from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
const roots: string[] = [];
const gitExecutable = "/usr/bin/git";
const extensions = { "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [] }, "git-ci": { ciRepositoryIds: ["root"], requiredJobs: [
  { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }, { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" }
] }, "merge-policy": {} } as const;

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
  root: {ref: main, protect: [main]}
policy:
  code-review: {requiredReviewerIds: [owner], pathReviewerRules: []}
  git-ci:
    ciRepositoryIds: [root]
    requiredJobs:
      - {name: source, kind: ordinary-sysbox, evidenceClass: candidate-controlled}
      - {name: integration, kind: qemu, evidenceClass: candidate-controlled}
  merge-policy: {}
`);
  }
  await writeFile(join(source, "README.md"), "pinned root\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
    "commit", "-m", "initial"]);
  return { source, scratch };
}

describe("native root bootstrap Git plan", () => {
  it("uses the connected reviewer for ordinary local imports without a manifest and preserves explicit policies", async () => {
    const { source, scratch } = await fixture(false);
    const input = { repositoryId: "root", gitExecutable, sourceRepository: source, selectedRef: "refs/heads/main", scratchRoot: scratch,
      reviewerId: "security", signal: AbortSignal.timeout(20_000) };
    const plan = await prepareNativeRootBootstrapGit({ ...input, policySource: { kind: "manifest-free" } });
    expect(plan.repositoryPolicy.extensions).toEqual({ "code-review": { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["security"] }] }, "merge-policy": {} });
    expect(plan.repositoryPolicy.branches).toEqual({ "refs/heads/main": { review: true }, "refs/heads/development": { review: false } });
    await plan.cleanup();
    const explicit = await prepareNativeRootBootstrapGit({ ...input, policySource: { kind: "manifest-free", extensions } });
    expect(explicit.repositoryPolicy.extensions).toEqual(extensions);
    await explicit.cleanup();
  });


  it("derives policy and a self-contained one-ref bundle from one pinned commit across source movement", async () => {
    const { source, scratch } = await fixture(true);
    const commit = await git(["-C", source, "rev-parse", "HEAD"]);
    const tree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
    const plan = await prepareNativeRootBootstrapGit({ repositoryId: "root", gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "reviewed-manifest" }, signal: AbortSignal.timeout(20_000) });
    expect(plan).toMatchObject({ expectedCommit: commit, resolvedTree: tree,
      protectedRef: "refs/heads/main", repositoryId: "root" });
    expect((plan.repositoryPolicy.extensions["git-ci"])).toMatchObject({ requiredJobs: [{ name: "source" }, { name: "integration" }] });
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
    await expect(prepareNativeRootBootstrapGit({ repositoryId: "root", gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "reviewed-manifest" }, signal: AbortSignal.timeout(20_000) })).rejects.toThrow();
    expect(await readdir(scratch)).toEqual([]);
    const plan = await prepareNativeRootBootstrapGit({ repositoryId: "root", gitExecutable, sourceRepository: source,
      selectedRef: "refs/heads/main", scratchRoot: scratch,
      policySource: { kind: "manifest-free", extensions },
      signal: AbortSignal.timeout(20_000) });
    expect((plan.repositoryPolicy.extensions["git-ci"])).toMatchObject({ requiredJobs: [{ name: "source" }, { name: "integration" }] });
    await plan.cleanup();
    expect(await readdir(scratch)).toEqual([]);
  });

  it("imports the planned commit and canonical policy through the real service without Git transport", async () => {
    const { source, scratch } = await fixture(true);
    const plan = await prepareNativeRootBootstrapGit({ repositoryId: "root", gitExecutable, sourceRepository: source,
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

    const imported = await client.importRepository({ serviceId: "native-main", projectId: "project-a",
      repositoryId: "root", protectedRef: plan.protectedRef, expectedCommit: plan.expectedCommit,
      policy: plan.repositoryPolicy, bundlePath: plan.bundlePath }, AbortSignal.timeout(20_000));

    expect(imported).toMatchObject({ phase: "repository-imported", expectedCommit: plan.expectedCommit,
      resolvedTree: plan.resolvedTree });
    expect(imported.policyDigest).toBe(createHash("sha256").update(JSON.stringify(plan.repositoryPolicy)).digest("hex"));
    expect(await git(["--git-dir", rootRepository(state), "show-ref", "--hash", "refs/heads/main"]))
      .toBe(plan.expectedCommit);
    const transport = await fetch(`${service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`);
    expect(transport.status).toBe(401);
    await plan.cleanup();
  });
});
