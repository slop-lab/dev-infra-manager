import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  LifecycleState,
  NativeProjectDraftStore,
  NativeProjectPendingStore,
  NativeProjectPendingStoreError,
  type NativeGitImportedRootProof,
  type NativeGitRootImporterClient,
  type NativeProjectDraftClaim
} from "../../../../core/packages/managed/src/index.js";
import { compileNativeRootBootstrapPolicy } from "../../../../core/packages/managed/src/nativeRootBootstrapPolicy.js";
import { publishNativeProjectPending } from "../../../../core/packages/managed/src/nativeProjectPendingFiles.js";

const roots: string[] = [];
const run = promisify(execFile);
const bundleBytes = Buffer.from("native pending bundle\n", "utf8");
const policy = compileNativeRootBootstrapPolicy({ rootAlias: "root", protectedRef: "refs/heads/main",
  review: { requiredReviewerIds: ["owner"], pathReviewerRules: [],
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox" }] } });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function importedDraftFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-pending-store-"));
  roots.push(root);
  const bundlePath = join(root, "source.bundle");
  await writeFile(bundlePath, bundleBytes, { mode: 0o600 });
  const claim: NativeProjectDraftClaim = { name: "acme", projectId: "project-a", ownerHostId: "host-a",
    generationId: "d".repeat(64), expectedCommit: "a".repeat(40), expectedTree: "b".repeat(40),
    bundlePath, ...policy };
  const receipt = { schemaVersion: 1, serviceId: "native-main", projectId: claim.projectId,
    rootRepositoryId: "root", generationId: claim.generationId,
    importNonce: "00000000-0000-4000-8000-000000000000", protectedRef: claim.protectedRef,
    expectedCommit: claim.expectedCommit,
    policyDigest: createHash("sha256").update(JSON.stringify(claim.reviewPolicy)).digest("hex"),
    bundleDigest: createHash("sha256").update(bundleBytes).digest("hex"), bundleSize: bundleBytes.length,
    resolvedTree: claim.expectedTree, phase: "root-imported" } as const;
  const drafts = new NativeProjectDraftStore(root);
  await drafts.claim(claim);
  const draft = await drafts.markRootImported(claim.name, receipt);
  if (draft.schemaVersion !== 2 || draft.phase !== "root-imported") throw new Error("fixture draft is not current");
  const proof: NativeGitImportedRootProof = { schemaVersion: 3, servingGenerationId: "e".repeat(64),
    ownerHostId: claim.ownerHostId, importReceipt: receipt,
    currentHead: { projectId: claim.projectId, sequence: 0, protectedRef: claim.protectedRef,
      commit: claim.expectedCommit, tree: claim.expectedTree, policyDigest: receipt.policyDigest } };
  return { root, claim, draft, proof, draftPath: join(root, "native-project-drafts", "acme.json") };
}

function importer(proof: NativeGitImportedRootProof, hostId = "host-a"):
NativeGitRootImporterClient & { readonly proofCalls: readonly string[] } {
  const proofCalls: string[] = [];
  return { hostId, generationId: proof.servingGenerationId, proofCalls,
    async attest() {},
    async proveRoot(projectId) { proofCalls.push(projectId); return proof; },
    async importRoot() { throw new Error("admission must not import a root"); } };
}

describe("native Project admission-pending store", () => {
  it("publishes mode-0600 canonical state and exactly replays it after restart with fresh proof", async () => {
    // Given
    const fixture = await importedDraftFixture();
    const client = importer(fixture.proof);
    const draftBefore = await readFile(fixture.draftPath);

    // When
    const first = await new NativeProjectPendingStore(fixture.root)
      .admit(fixture.claim.name, client, AbortSignal.timeout(5_000));
    const projectPath = new LifecycleState(fixture.root).projectPath(fixture.claim.name);
    const bytes = await readFile(projectPath);
    const before = await stat(projectPath, { bigint: true });
    const replay = await new NativeProjectPendingStore(fixture.root)
      .admit(fixture.claim.name, client, AbortSignal.timeout(5_000));
    const after = await stat(projectPath, { bigint: true });

    // Then
    expect(replay).toEqual(first);
    expect(await readFile(projectPath)).toEqual(bytes);
    expect({ ino: after.ino, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs })
      .toEqual({ ino: before.ino, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs });
    expect(bytes.toString("utf8")).toBe(`${JSON.stringify(first)}\n`);
    expect(client.proofCalls).toEqual([fixture.claim.projectId, fixture.claim.projectId]);
    expect((await stat(projectPath)).mode & 0o777).toBe(0o600);
    expect((await stat(projectPath)).nlink).toBe(1);
    expect((await stat(join(fixture.root, "projects"))).mode & 0o777).toBe(0o700);
    expect(await readFile(fixture.draftPath)).toEqual(draftBefore);
  });

  it("converges a same-inode two-link publication residue on exact replay", async () => {
    // Given
    const fixture = await importedDraftFixture();
    const client = importer(fixture.proof);
    const store = new NativeProjectPendingStore(fixture.root);
    await store.admit("acme", client, AbortSignal.timeout(5_000));
    const projectPath = join(fixture.root, "projects", "acme.json");
    const stagingPath = join(fixture.root, "projects",
      ".acme.json.00000000-0000-4000-8000-000000000000.tmp");
    await link(projectPath, stagingPath);
    const projectBefore = await stat(projectPath, { bigint: true });
    const stagingBefore = await stat(stagingPath, { bigint: true });
    const bytesBefore = await readFile(projectPath);
    const draftBefore = await readFile(fixture.draftPath);

    // When
    const replay = await store.admit("acme", client, AbortSignal.timeout(5_000));
    const projectAfter = await stat(projectPath, { bigint: true });

    // Then
    expect(replay).toMatchObject({ schemaVersion: 5, phase: "admission-pending" });
    expect({ project: projectBefore.ino, staging: stagingBefore.ino, nlink: projectBefore.nlink })
      .toEqual({ project: stagingBefore.ino, staging: stagingBefore.ino, nlink: 2n });
    expect({ ino: projectAfter.ino, mode: projectAfter.mode & 0o777n, nlink: projectAfter.nlink })
      .toEqual({ ino: projectBefore.ino, mode: 0o600n, nlink: 1n });
    expect(await readFile(projectPath)).toEqual(bytesBefore);
    expect(await readFile(fixture.draftPath)).toEqual(draftBefore);
    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.proofCalls).toEqual([fixture.claim.projectId, fixture.claim.projectId]);
  });

  it("retains two-link recovery evidence when directory sync fails after exclusive publication", async () => {
    const fixture = await importedDraftFixture();
    const client = importer(fixture.proof);
    const store = new NativeProjectPendingStore(fixture.root);
    await store.admit("acme", client, AbortSignal.timeout(5_000));
    const directory = join(fixture.root, "projects");
    const projectPath = join(directory, "acme.json");
    const bytes = await readFile(projectPath);
    await unlink(projectPath);

    await expect(publishNativeProjectPending(fixture.root, projectPath, bytes,
      async () => { throw new Error("injected directory sync failure"); }))
      .rejects.toThrow("canonical Project record cannot be published exclusively");
    const stageName = (await readdir(directory)).find((name) => name.startsWith(".acme.json."));
    expect(stageName).toBeDefined();
    const staged = join(directory, stageName ?? "missing");
    const before = await stat(projectPath, { bigint: true });
    expect((await stat(staged, { bigint: true })).ino).toBe(before.ino);
    expect(before.nlink).toBe(2n);
    expect(await readFile(projectPath)).toEqual(bytes);

    const replay = await store.admit("acme", client, AbortSignal.timeout(5_000));
    expect(replay.phase).toBe("admission-pending");
    expect((await stat(projectPath, { bigint: true })).nlink).toBe(1n);
    await expect(lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.proofCalls).toEqual([fixture.claim.projectId, fixture.claim.projectId]);
  });

  it.each(["partial", "foreign", "symlink", "wrong-mode", "mismatched"] as const)(
    "preserves and refuses %s publication staging", async (kind) => {
      // Given
      const fixture = await importedDraftFixture();
      const store = new NativeProjectPendingStore(fixture.root);
      const client = importer(fixture.proof);
      const projectDirectory = join(fixture.root, "projects");
      const projectPath = join(projectDirectory, "acme.json");
      const stagingPath = join(projectDirectory,
        ".acme.json.00000000-0000-4000-8000-000000000000.tmp");
      if (kind === "partial") {
        await mkdir(projectDirectory, { mode: 0o700 });
        await writeFile(stagingPath, "partial\n", { mode: 0o600 });
      } else {
        await store.admit("acme", client, AbortSignal.timeout(5_000));
        const canonicalBytes = await readFile(projectPath);
        if (kind === "symlink") await symlink(projectPath, stagingPath);
        else await writeFile(stagingPath, kind === "mismatched" ? "mismatch\n" : canonicalBytes,
          { mode: kind === "wrong-mode" ? 0o640 : 0o600 });
      }
      const draftBefore = await readFile(fixture.draftPath);
      const projectBefore = kind === "partial" ? undefined : await readFile(projectPath);
      const stagingBefore = await lstat(stagingPath, { bigint: true });
      const stagingBytesBefore = kind === "symlink" ? Buffer.from(await readlink(stagingPath)) : await readFile(stagingPath);

      // When / Then
      await expect(store.admit("acme", client, AbortSignal.timeout(5_000)))
        .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
      expect(await readFile(fixture.draftPath)).toEqual(draftBefore);
      if (projectBefore === undefined) await expect(lstat(projectPath)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(projectPath)).toEqual(projectBefore);
      const stagingAfter = await lstat(stagingPath, { bigint: true });
      expect({ ino: stagingAfter.ino, mode: stagingAfter.mode, nlink: stagingAfter.nlink })
        .toEqual({ ino: stagingBefore.ino, mode: stagingBefore.mode, nlink: stagingBefore.nlink });
      const stagingBytesAfter = kind === "symlink" ? Buffer.from(await readlink(stagingPath)) : await readFile(stagingPath);
      expect(stagingBytesAfter).toEqual(stagingBytesBefore);
    }
  );

  it("rejects duplicate canonical keys without changing persisted evidence", async () => {
    // Given
    const fixture = await importedDraftFixture();
    const store = new NativeProjectPendingStore(fixture.root);
    await store.admit("acme", importer(fixture.proof), AbortSignal.timeout(5_000));
    const projectPath = join(fixture.root, "projects", "acme.json");
    const bytes = Buffer.from((await readFile(projectPath, "utf8")).replace('"name":"acme"',
      '"name":"other","name":"acme"'));
    await writeFile(projectPath, bytes, { mode: 0o600 });

    // When / Then
    await expect(store.read("acme", "host-a")).rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    expect(await readFile(projectPath)).toEqual(bytes);
  });

  it("rejects an owner-mode canonical FIFO without blocking", async () => {
    // Given
    const fixture = await importedDraftFixture();
    const projectDirectory = join(fixture.root, "projects");
    await mkdir(projectDirectory, { mode: 0o700 });
    const projectPath = join(projectDirectory, "acme.json");
    await run("/usr/bin/mkfifo", [projectPath]);
    await chmod(projectPath, 0o600);
    const moduleUrl = pathToFileURL(join(import.meta.dirname,
      "../../../../core/packages/managed/dist/nativeProjectPendingFiles.js")).href;

    // When
    const child = run(process.execPath, ["--input-type=module", "-e", `
      const { readNativeProjectPending } = await import(process.env.DIM_TEST_MODULE);
      await readNativeProjectPending(process.env.DIM_TEST_ROOT, process.env.DIM_TEST_PATH).then(
        () => process.exit(1),
        () => process.exit(0),
      );
    `], { env: { ...process.env, DIM_TEST_MODULE: moduleUrl,
      DIM_TEST_ROOT: fixture.root, DIM_TEST_PATH: projectPath }, timeout: 1_000 });

    // Then
    await expect(child).resolves.toMatchObject({ stdout: "", stderr: "" });
  });

  it("holds the existing Project lock through fresh proof and canonical publication", async () => {
    // Given
    const fixture = await importedDraftFixture();
    let proofStarted = () => {};
    const started = new Promise<void>((resolve) => { proofStarted = resolve; });
    let releaseProof = () => {};
    const proofGate = new Promise<void>((resolve) => { releaseProof = resolve; });
    const client: NativeGitRootImporterClient = {
      hostId: fixture.proof.ownerHostId,
      generationId: fixture.proof.servingGenerationId,
      async attest() {},
      async proveRoot() { proofStarted(); await proofGate; return fixture.proof; },
      async importRoot() { throw new Error("admission must not import a root"); }
    };
    const admission = new NativeProjectPendingStore(fixture.root)
      .admit("acme", client, AbortSignal.timeout(5_000));
    await started;
    let competingLockFinished = false;
    const competingLock = new LifecycleState(fixture.root).acquireProjectLock("acme")
      .then(async (release) => { competingLockFinished = true; await release(); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const competingLockWasBlocked = !competingLockFinished;

    // When
    releaseProof();
    await admission;
    await competingLock;

    // Then
    expect(competingLockWasBlocked).toBe(true);
    expect(competingLockFinished).toBe(true);
  });

  it.each(["owner", "policy", "receipt", "head"] as const)(
    "rejects a wrong %s proof before changing either namespace", async (change) => {
      // Given
      const fixture = await importedDraftFixture();
      const proof = change === "owner" ? { ...fixture.proof, ownerHostId: "host-b" }
        : change === "policy" ? { ...fixture.proof, currentHead: {
          ...fixture.proof.currentHead, policyDigest: "f".repeat(64) } }
        : change === "receipt" ? { ...fixture.proof, importReceipt: {
          ...fixture.proof.importReceipt, importNonce: "10000000-0000-4000-8000-000000000000" } }
        : { ...fixture.proof, currentHead: { ...fixture.proof.currentHead, sequence: 1 } };
      const before = await readFile(fixture.draftPath);

      // When / Then
      await expect(new NativeProjectPendingStore(fixture.root)
        .admit(fixture.claim.name, importer(proof), AbortSignal.timeout(5_000)))
        .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
      expect(await readFile(fixture.draftPath)).toEqual(before);
      await expect(stat(join(fixture.root, "projects"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("rejects wrong-service, legacy, incomplete staging, and Gitea state without adoption", async () => {
    // Given
    const wrongService = await importedDraftFixture();
    await writeFile(wrongService.draftPath,
      `${JSON.stringify({ ...wrongService.draft, serviceId: "foreign-native" })}\n`, { mode: 0o600 });
    const legacy = await importedDraftFixture();
    await writeFile(legacy.draftPath, `${JSON.stringify({ ...legacy.draft, schemaVersion: 1 })}\n`, { mode: 0o600 });
    const staged = await importedDraftFixture();
    await mkdir(join(staged.root, "projects"), { mode: 0o700 });
    const stagingPath = join(staged.root, "projects", ".acme.json.00000000-0000-4000-8000-000000000000.tmp");
    await writeFile(stagingPath, "incomplete\n", { mode: 0o600 });
    const collision = await importedDraftFixture();
    await mkdir(join(collision.root, "projects"), { mode: 0o700 });
    const projectPath = join(collision.root, "projects", "acme.json");
    const giteaBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 4, id: "project-a", name: "acme",
      gitNamespace: "dim-acme", giteaOrganizationId: 41, phase: "ready", repositories: [],
      createdAt: "now", updatedAt: "now" })}\n`);
    await writeFile(projectPath, giteaBytes, { mode: 0o600 });
    expect(await readFile(projectPath)).toEqual(giteaBytes);

    // When / Then
    await expect(new NativeProjectPendingStore(wrongService.root)
      .admit("acme", importer(wrongService.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    await expect(new NativeProjectPendingStore(legacy.root)
      .admit("acme", importer(legacy.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    await expect(new NativeProjectPendingStore(staged.root)
      .admit("acme", importer(staged.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    expect(await readFile(stagingPath, "utf8")).toBe("incomplete\n");
    await expect(new NativeProjectPendingStore(collision.root)
      .admit("acme", importer(collision.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    expect(await readFile(projectPath)).toEqual(giteaBytes);
  });

  it("fails closed when canonical state has unsafe mode or link count", async () => {
    // Given
    const permissive = await importedDraftFixture();
    await new NativeProjectPendingStore(permissive.root)
      .admit("acme", importer(permissive.proof), AbortSignal.timeout(5_000));
    const permissivePath = join(permissive.root, "projects", "acme.json");
    await chmod(permissivePath, 0o640);
    const linked = await importedDraftFixture();
    await new NativeProjectPendingStore(linked.root)
      .admit("acme", importer(linked.proof), AbortSignal.timeout(5_000));
    const linkedPath = join(linked.root, "projects", "acme.json");
    await link(linkedPath, join(linked.root, "extra-link.json"));

    // When / Then
    await expect(new NativeProjectPendingStore(permissive.root)
      .admit("acme", importer(permissive.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    await expect(new NativeProjectPendingStore(linked.root)
      .admit("acme", importer(linked.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
  });

  it.runIf(process.geteuid?.() === 0)("rejects canonical state owned by a foreign uid", async () => {
    // Given
    const fixture = await importedDraftFixture();
    const store = new NativeProjectPendingStore(fixture.root);
    await store.admit("acme", importer(fixture.proof), AbortSignal.timeout(5_000));
    const projectPath = join(fixture.root, "projects", "acme.json");
    const before = await readFile(projectPath);
    await chown(projectPath, 65_534, 65_534);

    // When / Then
    await expect(store.admit("acme", importer(fixture.proof), AbortSignal.timeout(5_000)))
      .rejects.toBeInstanceOf(NativeProjectPendingStoreError);
    expect(await readFile(projectPath)).toEqual(before);
  });
});
