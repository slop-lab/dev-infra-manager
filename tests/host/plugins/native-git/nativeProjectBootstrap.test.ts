import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapNativeProjectRepository, NativeProjectBootstrapError, NativeProjectDraftStore, NativeProjectPendingStore } from "@slop-lab/dim-host-plugin-native-git";
import { bundleSecrets } from "../../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { activateFinalizeService, cleanupFinalizeFixtures, createFinalizeRoot,
  activateFinalizeServiceForGeneration, activationTokenB, closeFinalizeService, generationB,
  generationId, importer, rootRepository, startFinalizeService, startFinalizeServiceForGeneration
} from "../../../control-plane/plugins/git-repositories/nativeRootImportFinalizeFixture.js";

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
  await new NativeProjectPendingStore(root).create({ name: "acme", projectId: "project-a", ownerHostId: importer.hostId });
  const input = { repositoryId: "root", name: "acme", projectId: "project-a", stateRoot: root, scratchRoot, sourceRepository,
    gitExecutable: "/usr/bin/git", selectedRef: "refs/heads/main",
    policySource: { kind: "reviewed-manifest" as const }, registrarConnectionFile, importerConnectionFile,
    signal: AbortSignal.timeout(20_000) };
  return { root, state, service, input };
}

describe("trusted native Project bootstrap", () => {
  it("imports a pinned protected head and persists only an exact non-ready native draft", async () => {
    const { root, state, service, input } = await fixture();

    const imported = await bootstrapNativeProjectRepository(input);

    expect(imported).toMatchObject({ name: "acme", projectId: "project-a", ownerHostId: "host-a",
      generationId, phase: "repository-imported", importReceipt: { phase: "repository-imported" } });
    expect(imported.schemaVersion).toBe(3);
    if (imported.schemaVersion !== 3) throw new Error("fresh native draft did not use schema 2");
    expect(imported.repositoryPolicy.extensions["git-ci"]).toMatchObject({ requiredJobs: [{ kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }, { kind: "qemu", evidenceClass: "candidate-controlled" }] });
    expect(await new NativeProjectDraftStore(root).read("acme", "root")).toEqual(imported);
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(state), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(imported.expectedCommit);
    const transport = await fetch(`${service.origin}/v1/projects/project-a/repositories/root.git/info/refs?service=git-upload-pack`);
    expect(transport.status).toBe(401);
    expect(await bootstrapNativeProjectRepository(input)).toEqual(imported);
  });

  it("recovers an import completed by native Git before its receipt reached the host draft", async () => {
    const { root, state, input } = await fixture();
    const imported = await bootstrapNativeProjectRepository(input);
    if (imported.phase !== "repository-imported") throw new Error("bootstrap fixture did not import the root");
    const { importReceipt, ...boundFields } = imported;
    expect(importReceipt.phase).toBe("repository-imported");
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    await writeFile(recordPath, `${JSON.stringify({ ...boundFields, phase: "import-pending" })}\n`, { mode: 0o600 });
    expect(await new NativeProjectDraftStore(root).read("acme", "root")).toMatchObject({ phase: "import-pending" });

    const recovered = await bootstrapNativeProjectRepository(input);

    expect(recovered).toEqual(imported);
    expect((await run("/usr/bin/git", ["--git-dir", rootRepository(state), "rev-parse",
      "refs/heads/main"])).stdout.trim()).toBe(imported.expectedCommit);
  });

  it("replays an unchanged generation-A imported draft through active generation B without rewriting it", async () => {
    // Given
    const { root, state, service, input } = await fixture();
    const imported = await bootstrapNativeProjectRepository(input);
    if (imported.phase !== "repository-imported") throw new Error("bootstrap fixture did not import the root");
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    const artifactPath = join(root, "native-project-drafts", "artifacts", imported.projectId, imported.repositoryId,
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
    const replayed = await bootstrapNativeProjectRepository(input);

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
    const imported = await bootstrapNativeProjectRepository(input);
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    const before = await readFile(recordPath);
    const movedCommit = (await run("/usr/bin/git", ["--git-dir", rootRepository(state),
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
      "commit-tree", imported.expectedTree, "-m", "moved root"])).stdout.trim();
    await run("/usr/bin/git", ["--git-dir", rootRepository(state), "update-ref",
      "refs/heads/main", movedCommit, imported.expectedCommit]);

    await expect(bootstrapNativeProjectRepository(input)).rejects.toThrow(NativeProjectBootstrapError);

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

    await expect(bootstrapNativeProjectRepository(input)).rejects.toThrow(NativeProjectBootstrapError);

    expect(await readFile(database)).toEqual(before);
    await expect(stat(join(root, "native-project-drafts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new NativeProjectPendingStore(root).read("acme", importer.hostId))?.phase).toBe("configuring");
  });
});
