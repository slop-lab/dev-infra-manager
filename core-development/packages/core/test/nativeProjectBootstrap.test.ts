import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapNativeProjectRoot, NativeProjectBootstrapError,
  NativeProjectDraftStore } from "../../../../core/packages/core/src/index.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot,
  activateFinalizeServiceForGeneration, activationTokenB, closeFinalizeService, generationB,
  generationId, importer, rootRepository, startFinalizeService, startFinalizeServiceForGeneration
} from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(change: Readonly<Record<string, unknown>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-bootstrap-host-"));
  roots.push(root);
  const scratchRoot = join(root, "scratch");
  const sourceRepository = join(root, "source");
  await mkdir(scratchRoot, { mode: 0o700 });
  await run("/usr/bin/git", ["init", "--initial-branch=main", sourceRepository]);
  await mkdir(join(sourceRepository, ".dim"));
  await writeFile(join(sourceRepository, ".dim/repos.yml"), `schemaVersion: 1
repositories:
  root: {url: https://example.test/root.git, root: true, ref: main, protect: [main]}
nativeReview:
  requiredReviewerIds: [owner]
  pathReviewerRules: []
  requiredJobs:
    - {name: source, kind: ordinary-sysbox}
    - {name: integration, kind: qemu}
`);
  await writeFile(join(sourceRepository, "README.md"), "pinned bootstrap\n");
  await run("/usr/bin/git", ["-C", sourceRepository, "add", "."]);
  await run("/usr/bin/git", ["-C", sourceRepository, "-c", "user.name=DIM Test",
    "-c", "user.email=dim@example.invalid", "commit", "-m", "root"]);
  const state = await createFinalizeRoot("host-bootstrap-service");
  const service = await startFinalizeService(state);
  await activateFinalizeService(service.origin);
  const registrarConnectionFile = join(root, "registrar.json");
  const importerConnectionFile = join(root, "importer.json");
  await writeFile(registrarConnectionFile, JSON.stringify({ schemaVersion: 1, endpoint: service.origin,
    serviceId: "native-main", hostId: importer.hostId, generationId,
    credential: { username: "registrar-a", password: bundleSecrets.projectRegistrar } }), { mode: 0o600 });
  await writeFile(importerConnectionFile, JSON.stringify({ schemaVersion: 1, endpoint: service.origin,
    serviceId: "native-main", role: "operator-root-importer", hostId: importer.hostId, generationId,
    credential: { username: importer.username, password: importer.password }, ...change }), { mode: 0o600 });
  const input = { name: "acme", projectId: "project-a", stateRoot: root, scratchRoot, sourceRepository,
    gitExecutable: "/usr/bin/git", selectedRef: "refs/heads/main",
    policySource: { kind: "reviewed-manifest" as const }, registrarConnectionFile, importerConnectionFile,
    signal: AbortSignal.timeout(20_000) };
  return { root, state, service, input };
}

describe("trusted native Project bootstrap", () => {
  it("imports a pinned protected head and persists only an exact non-ready native draft", async () => {
    const { root, state, service, input } = await fixture();

    const imported = await bootstrapNativeProjectRoot(input);

    expect(imported).toMatchObject({ name: "acme", projectId: "project-a", ownerHostId: "host-a",
      generationId, phase: "root-imported", importReceipt: { phase: "root-imported" } });
    expect(imported.schemaVersion).toBe(2);
    if (imported.schemaVersion !== 2) throw new Error("fresh native draft did not use schema 2");
    expect(imported.reviewPolicy.requiredJobs.map(({ kind }) => kind)).toEqual(["qemu", "ordinary-sysbox"]);
    expect(await new NativeProjectDraftStore(root).read("acme")).toEqual(imported);
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(state), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(imported.expectedCommit);
    expect(await new LifecycleState(root).listProjects()).toEqual([]);
    const transport = await fetch(`${service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`);
    expect(transport.status).toBe(401);
    expect(await bootstrapNativeProjectRoot(input)).toEqual(imported);
  });

  it("recovers an import completed by native Git before its receipt reached the host draft", async () => {
    const { root, state, input } = await fixture();
    const imported = await bootstrapNativeProjectRoot(input);
    if (imported.phase !== "root-imported") throw new Error("bootstrap fixture did not import the root");
    const { importReceipt, ...boundFields } = imported;
    expect(importReceipt.phase).toBe("root-imported");
    const recordPath = join(root, "native-project-drafts", "acme.json");
    await writeFile(recordPath, `${JSON.stringify({ ...boundFields, phase: "import-pending" })}\n`, { mode: 0o600 });
    expect(await new NativeProjectDraftStore(root).read("acme")).toMatchObject({ phase: "import-pending" });

    const recovered = await bootstrapNativeProjectRoot(input);

    expect(recovered).toEqual(imported);
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(state), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(imported.expectedCommit);
  });

  it("replays an unchanged generation-A imported draft through active generation B without rewriting it", async () => {
    // Given
    const { root, state, service, input } = await fixture();
    const imported = await bootstrapNativeProjectRoot(input);
    if (imported.phase !== "root-imported") throw new Error("bootstrap fixture did not import the root");
    const recordPath = join(root, "native-project-drafts", "acme.json");
    const artifactPath = join(root, "native-project-drafts", "artifacts", imported.projectId,
      `${imported.bundleDigest}.bundle`);
    await closeFinalizeService(service);
    const servingB = await startFinalizeServiceForGeneration(state, generationB, activationTokenB);
    await activateFinalizeServiceForGeneration(servingB.origin, generationB, activationTokenB);
    await writeFile(input.registrarConnectionFile, JSON.stringify({ schemaVersion: 1, endpoint: servingB.origin,
      serviceId: "native-main", hostId: importer.hostId, generationId: generationB,
      credential: { username: "registrar-a", password: bundleSecrets.projectRegistrar } }), { mode: 0o600 });
    await writeFile(input.importerConnectionFile, JSON.stringify({ schemaVersion: 1, endpoint: servingB.origin,
      serviceId: "native-main", role: "operator-root-importer", hostId: importer.hostId,
      generationId: generationB, credential: { username: importer.username, password: importer.password } }),
    { mode: 0o600 });
    const before = { record: await readFile(recordPath), artifact: await readFile(artifactPath),
      database: await readFile(join(state, "native-idle.sqlite3")) };

    // When
    const replayed = await bootstrapNativeProjectRoot(input);

    // Then
    expect(replayed).toEqual(imported);
    expect(imported.importReceipt.generationId).toBe(generationId);
    expect(await readFile(recordPath)).toEqual(before.record);
    expect(await readFile(artifactPath)).toEqual(before.artifact);
    expect(await readFile(join(state, "native-idle.sqlite3"))).toEqual(before.database);
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(state), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(imported.expectedCommit);
  });

  it("refuses an imported draft after its live protected head moves without changing host state", async () => {
    const { root, state, input } = await fixture();
    const imported = await bootstrapNativeProjectRoot(input);
    const recordPath = join(root, "native-project-drafts", "acme.json");
    const before = await readFile(recordPath);
    const movedCommit = (await run("/usr/bin/git", ["--git-dir", rootRepository(state),
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
      "commit-tree", imported.expectedTree, "-m", "moved root"])).stdout.trim();
    await run("/usr/bin/git", ["--git-dir", rootRepository(state), "update-ref",
      "refs/heads/main", movedCommit, imported.expectedCommit]);

    await expect(bootstrapNativeProjectRoot(input)).rejects.toThrow(NativeProjectBootstrapError);

    expect(await readFile(recordPath)).toEqual(before);
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(state), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(movedCommit);
  });

  it.each([
    ["hostId", "host-b"], ["generationId", "b".repeat(64)], ["endpoint", "http://127.0.0.1:1"]
  ] as const)("refuses a mismatched %s before draft or service mutation", async (field, value) => {
    const { root, state, input } = await fixture({ [field]: value });
    const database = join(state, "native-idle.sqlite3");
    const before = await readFile(database);

    await expect(bootstrapNativeProjectRoot(input)).rejects.toThrow(NativeProjectBootstrapError);

    expect(await readFile(database)).toEqual(before);
    await expect(stat(join(root, "native-project-drafts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "projects"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
