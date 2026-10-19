import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, chown, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NativeProjectDraftStore, NativeProjectDraftStoreError, type NativeGitRootImportResult, type NativeProjectDraftClaim } from "@slop-lab/dim-host-plugin-native-git";
import { compileNativeRepositoryBootstrapPolicy } from "../../../../packages/host/plugins/native-git/src/nativeRootBootstrapPolicy.js";

const roots: string[] = [];
const run = promisify(execFile);
const bundleBytes = Buffer.from("private native root bundle\n", "utf8");
const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main",
  review: { ciRepositoryIds: ["root"], requiredReviewerIds: ["owner"], pathReviewerRules: [], requiredJobs: [
    { name: "source", kind: "ordinary-sysbox" }, { name: "integration", kind: "qemu" }
  ] } });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly claim: NativeProjectDraftClaim }> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-draft-store-"));
  roots.push(root);
  const source = join(root, "source.bundle");
  await writeFile(source, bundleBytes, { mode: 0o600 });
  return { root, claim: { name: "acme", projectId: "project-a", ownerHostId: "host-a",
    generationId: "a".repeat(64), bundlePath: source, ...policy,
    expectedCommit: "b".repeat(40), expectedTree: "c".repeat(40) } };
}

function receipt(claim: NativeProjectDraftClaim): NativeGitRootImportResult {
  return { schemaVersion: 1, serviceId: "native-main", projectId: claim.projectId,
    repositoryId: "root", generationId: claim.generationId,
    importNonce: "00000000-0000-4000-8000-000000000000", protectedRef: claim.protectedRef,
    expectedCommit: claim.expectedCommit,
    policyDigest: createHash("sha256").update(JSON.stringify(claim.reviewPolicy)).digest("hex"),
    bundleDigest: createHash("sha256").update(bundleBytes).digest("hex"), bundleSize: bundleBytes.length,
    resolvedTree: claim.expectedTree, phase: "repository-imported" };
}

describe("native Project draft store", () => {
  it("publishes a private pending draft and exact bundle that a new store instance fully rereads", async () => {
    // Given
    const { root, claim } = await fixture();

    // When
    const pending = await new NativeProjectDraftStore(root).claim(claim);
    const reread = await new NativeProjectDraftStore(root).read(claim.name, claim.repositoryId);

    // Then
    const digest = createHash("sha256").update(bundleBytes).digest("hex");
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    const artifactDirectory = join(root, "native-project-drafts", "artifacts", claim.projectId, claim.repositoryId);
    const artifactPath = join(artifactDirectory, `${digest}.bundle`);
    expect(reread).toEqual(pending);
    expect(pending).toMatchObject({ phase: "import-pending", bundleDigest: digest,
      bundleSize: bundleBytes.length });
    expect(await readFile(artifactPath)).toEqual(bundleBytes);
    await expect(stat(join(root, "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of [join(root, "native-project-drafts"),
      join(root, "native-project-drafts", "artifacts"), artifactDirectory]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const file of [recordPath, artifactPath]) {
      const metadata = await stat(file);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
    }
    const record = await readFile(recordPath, "utf8");
    expect(record).not.toMatch(/credential|password|ready/i);
  });

  it("replays only an identical pending intent", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    const pending = await store.claim(claim);

    // When / Then
    expect(await store.claim(claim)).toEqual(pending);
    await expect(store.claim({ ...claim, expectedCommit: "d".repeat(40) }))
      .rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    await expect(store.claim({ ...claim, ownerHostId: "host-b" }))
      .rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    await writeFile(claim.bundlePath, "changed private native root bundle\n", { mode: 0o600 });
    await expect(store.claim(claim)).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
  });

  it("advances only to an exactly receipt-bound imported record and exactly replays it", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    await store.claim(claim);
    const importedReceipt = receipt(claim);

    // When
    const imported = await store.markRepositoryImported(claim.name, claim.repositoryId, importedReceipt);

    // Then
    expect(imported).toEqual({ ...await new NativeProjectDraftStore(root).read(claim.name, claim.repositoryId),
      phase: "repository-imported", importReceipt: importedReceipt });
    expect(await store.markRepositoryImported(claim.name, claim.repositoryId, importedReceipt)).toEqual(imported);
    await expect(store.markRepositoryImported(claim.name, claim.repositoryId, { ...importedReceipt,
      importNonce: "10000000-0000-4000-8000-000000000000" }))
      .rejects.toBeInstanceOf(NativeProjectDraftStoreError);
  });

  it("replays an imported draft across a serving generation without rewriting its original receipt", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    await store.claim(claim);
    const imported = await store.markRepositoryImported(claim.name, claim.repositoryId, receipt(claim));
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    const before = await readFile(recordPath);

    // When
    const replayed = await store.claim({ ...claim, generationId: "b".repeat(64) });

    // Then
    expect(replayed).toEqual(imported);
    expect(await readFile(recordPath)).toEqual(before);
  });

  it("rejects obsolete draft schemas without changing records or replaying imports", async () => {
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    const draft = await store.claim(claim);
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    for (const phase of ["import-pending", "repository-imported"]) {
      await writeFile(recordPath, `${JSON.stringify({ ...draft, schemaVersion: 1, phase })}\n`, { mode: 0o600 });
      const before = await readFile(recordPath);
      await expect(store.read(claim.name, claim.repositoryId)).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
      await expect(store.claim(claim)).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
      expect(await readFile(recordPath)).toEqual(before);
    }
  });

  it("keeps a pending draft bound to its original generation without rewriting it", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    await store.claim(claim);
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    const before = await readFile(recordPath);

    // When / Then
    await expect(store.claim({ ...claim, generationId: "b".repeat(64) }))
      .rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    expect(await readFile(recordPath)).toEqual(before);
  });

  it.each(["receipt", "commit", "bundle", "name"] as const)(
    "rejects a changed imported %s without rewriting the current record", async (change) => {
      // Given
      const { root, claim } = await fixture();
      const store = new NativeProjectDraftStore(root);
      await store.claim(claim);
      const importedReceipt = receipt(claim);
      await store.markRepositoryImported(claim.name, claim.repositoryId, importedReceipt);
      const recordPath = join(root, "native-project-drafts", "acme", "root.json");
      if (change === "bundle") {
        await writeFile(claim.bundlePath, "changed private native root bundle\n", { mode: 0o600 });
      } else if (change === "name") {
        const current = JSON.parse(await readFile(recordPath, "utf8"));
        await writeFile(recordPath, `${JSON.stringify({ ...current, name: "other" })}\n`, { mode: 0o600 });
      }
      const before = await readFile(recordPath);

      // When / Then
      const rejection = change === "receipt"
        ? store.markRepositoryImported(claim.name, claim.repositoryId, { ...importedReceipt,
          importNonce: "10000000-0000-4000-8000-000000000000" })
        : store.claim(change === "commit" ? { ...claim, expectedCommit: "d".repeat(40) } : claim);
      await expect(rejection).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
      expect(await readFile(recordPath)).toEqual(before);
    }
  );

  it("refuses symbolic, foreign, corrupt, and unsafe persisted nodes", async () => {
    // Given
    const symbolic = await fixture();
    await mkdir(join(symbolic.root, "native-project-drafts"), { mode: 0o700 });
    await mkdir(join(symbolic.root, "native-project-drafts", "acme"), { mode: 0o700 });
    await symlink(symbolic.claim.bundlePath, join(symbolic.root, "native-project-drafts", "acme", "root.json"));
    const foreign = await fixture();
    await mkdir(join(foreign.root, "native-project-drafts"), { mode: 0o700 });
    await mkdir(join(foreign.root, "native-project-drafts", "acme"), { mode: 0o700 });
    await mkdir(join(foreign.root, "native-project-drafts", "acme", "root.json"), { mode: 0o700 });
    const corrupt = await fixture();
    const corruptStore = new NativeProjectDraftStore(corrupt.root);
    const corruptDraft = await corruptStore.claim(corrupt.claim);
    const corruptArtifact = join(corrupt.root, "native-project-drafts", "artifacts", corrupt.claim.projectId, corrupt.claim.repositoryId,
      `${corruptDraft.bundleDigest}.bundle`);
    await writeFile(corruptArtifact, Buffer.alloc(corruptDraft.bundleSize, 0x78));
    const linked = await fixture();
    const linkedStore = new NativeProjectDraftStore(linked.root);
    const linkedDraft = await linkedStore.claim(linked.claim);
    const linkedArtifact = join(linked.root, "native-project-drafts", "artifacts", linked.claim.projectId, linked.claim.repositoryId,
      `${linkedDraft.bundleDigest}.bundle`);
    await link(linkedArtifact, join(linked.root, "extra-link.bundle"));
    const permissive = await fixture();
    const permissiveStore = new NativeProjectDraftStore(permissive.root);
    await permissiveStore.claim(permissive.claim);
    await chmod(join(permissive.root, "native-project-drafts", "acme", "root.json"), 0o644);

    // When / Then
    await expect(new NativeProjectDraftStore(symbolic.root).read("acme", "root"))
      .rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    await expect(new NativeProjectDraftStore(foreign.root).read("acme", "root"))
      .rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    await expect(corruptStore.read("acme", "root")).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    await expect(linkedStore.read("acme", "root")).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    await expect(permissiveStore.read("acme", "root")).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
  });

  it("rejects duplicate draft keys without changing persisted evidence", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    await store.claim(claim);
    const recordPath = join(root, "native-project-drafts", "acme", "root.json");
    const bytes = Buffer.from((await readFile(recordPath, "utf8")).replace('"name":"acme"',
      '"name":"other","name":"acme"'));
    await writeFile(recordPath, bytes, { mode: 0o600 });

    // When / Then
    await expect(store.read("acme", "root")).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
    expect(await readFile(recordPath)).toEqual(bytes);
  });

  it.each(["draft record", "retained artifact"] as const)(
    "rejects an owner-mode FIFO at the %s boundary without blocking", async (boundary) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "dim-native-draft-fifo-"));
      roots.push(root);
      const path = join(root, boundary === "draft record" ? "draft.json" : "artifact.bundle");
      await run("/usr/bin/mkfifo", [path]);
      await chmod(path, 0o600);
      const moduleUrl = pathToFileURL(join(import.meta.dirname,
        "../../../../packages/host/plugins/native-git/dist/nativeProjectDraftFiles.js")).href;
      const exportName = boundary === "draft record" ? "readPrivateDraftJson" : "inspectPrivateBundle";

      // When
      const child = run(process.execPath, ["--input-type=module", "-e", `
        const module = await import(process.env.DIM_TEST_MODULE);
        await module[process.env.DIM_TEST_EXPORT](process.env.DIM_TEST_PATH).then(
          () => process.exit(1),
          () => process.exit(0),
        );
      `], { env: { ...process.env, DIM_TEST_MODULE: moduleUrl,
        DIM_TEST_EXPORT: exportName, DIM_TEST_PATH: path }, timeout: 1_000 });

      // Then
      await expect(child).resolves.toMatchObject({ stdout: "", stderr: "" });
    }
  );

  it.runIf(process.geteuid?.() === 0)("refuses a draft record owned by a foreign uid", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    await store.claim(claim);
    await chown(join(root, "native-project-drafts", "acme", "root.json"), 65_534, 65_534);

    // When / Then
    await expect(store.read(claim.name, claim.repositoryId)).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
  });

  it.runIf(process.geteuid?.() === 0)("refuses a retained bundle owned by a foreign uid", async () => {
    // Given
    const { root, claim } = await fixture();
    const store = new NativeProjectDraftStore(root);
    const draft = await store.claim(claim);
    await chown(join(root, "native-project-drafts", "artifacts", claim.projectId, claim.repositoryId,
      `${draft.bundleDigest}.bundle`), 65_534, 65_534);

    // When / Then
    await expect(store.read(claim.name, claim.repositoryId)).rejects.toBeInstanceOf(NativeProjectDraftStoreError);
  });
});
