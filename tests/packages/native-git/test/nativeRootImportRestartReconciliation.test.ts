import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activationTokenSha256, bindExactActivation } from "../../../../core/packages/native-git/src/native-bundle-activation.js";
import {
  claimNativeProjectRootImport,
  initializeNativeGitBundleState,
  inspectNativeGitBundleState,
  markNativeProjectRootBundleDurable
} from "../../../../core/packages/native-git/src/native-bundle-state.js";
import { executeNativeProjectPreparation } from "../../../../core/packages/native-git/src/native-project-registration.js";
import { refValue } from "./nativeGitHarness.js";

const roots: string[] = [];
const generationId = "a".repeat(64);
const uploadName = ".00000000-0000-4000-8000-000000000001.upload";
const verifyName = ".verify-00000000-0000-4000-8000-000000000002";
const project = { serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root" } as const;
const intentInput = {
  ...project,
  protectedRef: "refs/heads/main",
  expectedCommit: "c".repeat(40),
  policy: {
    schemaVersion: 1,
    protectedRef: "refs/heads/main",
    policyRevision: "1260bff66b3d732abb336c2885d6a69a47e465369083c28875dc9cb09a9a480c",
    requiredReviewRevision: "02b474b992388d574069fe2806c9a918f3c660053df4ab6baf595d9d178ea824",
    requiredJobSetRevision: "b9763406fad20f0f816d6346d69d27eb953d7053301bd87275ba73b1f82bc8a1",
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }],
    requiredReviewerIds: ["owner"],
    pathReviewerRules: []
  }
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root import restart reconciliation", () => {
  it("removes only owned intent crash remnants while preserving the intent and protected ref", async () => {
    const fixture = await intentFixture();
    await writeFile(join(fixture.staging, uploadName), "partial upload", { mode: 0o600 });
    await writeFile(join(fixture.staging, `${fixture.importNonce}.bundle`), "published before SQL", { mode: 0o600 });
    await createVerificationTree(join(fixture.staging, verifyName));
    const databaseBefore = await readFile(join(fixture.root, "native-idle.sqlite3"));
    const stagingBefore = await treeSnapshot(fixture.staging);

    expect(await inspectNativeGitBundleState(fixture.root)).toEqual({ stateFormat: 8 });
    expect(await treeSnapshot(fixture.staging)).toEqual(stagingBefore);
    const restarted = await initializeNativeGitBundleState(fixture.root);

    expect(await readdir(fixture.staging)).toEqual([]);
    expect(await readFile(join(fixture.root, "native-idle.sqlite3"))).toEqual(databaseBefore);
    expect(claimNativeProjectRootImport(restarted, generationId, "host-a", intentInput).importNonce)
      .toBe(fixture.importNonce);
    expect(await refValue(join(fixture.root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
    await restarted.owner.release();
  });

  it("retains only the verified hash-bound bundle for a durable row", async () => {
    const fixture = await intentFixture();
    const finalBytes = Buffer.from("durable bundle bytes\n");
    const finalPath = join(fixture.staging, `${fixture.importNonce}.bundle`);
    const state = await initializeNativeGitBundleState(fixture.root);
    await writeFile(finalPath, finalBytes, { mode: 0o600 });
    markNativeProjectRootBundleDurable(state, "project-a", fixture.importNonce,
      createHash("sha256").update(finalBytes).digest("hex"), finalBytes.length);
    await state.owner.release();
    await writeFile(join(fixture.staging, uploadName), "partial upload", { mode: 0o600 });
    await createVerificationTree(join(fixture.staging, verifyName));

    const restarted = await initializeNativeGitBundleState(fixture.root);

    expect(await readdir(fixture.staging)).toEqual([`${fixture.importNonce}.bundle`]);
    expect(await readFile(finalPath)).toEqual(finalBytes);
    expect(await refValue(join(fixture.root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
    await restarted.owner.release();
  });

  it("rejects an otherwise valid staging artifact without a bound import intent", async () => {
    const fixture = await preparedFixture();
    const staging = join(fixture.root, "project-a", ".dim-root-import");
    await mkdir(staging, { mode: 0o700 });
    await chmod(staging, 0o700);
    await writeFile(join(staging, uploadName), "unbound", { mode: 0o600 });
    await fixture.state.owner.release();
    const before = await treeSnapshot(staging);

    await expect(inspectNativeGitBundleState(fixture.root)).rejects.toThrow(/bound intent/i);
    await expect(initializeNativeGitBundleState(fixture.root)).rejects.toThrow(/bound intent/i);

    expect(await treeSnapshot(staging)).toEqual(before);
  });

  it.runIf(process.geteuid?.() === 0)("rejects a foreign-owned upload byte-identically", async () => {
    const fixture = await intentFixture();
    const path = join(fixture.staging, uploadName);
    await writeFile(path, "keep", { mode: 0o600 });
    await chown(path, 1, 1);
    const before = await treeSnapshot(fixture.staging);

    await expect(initializeNativeGitBundleState(fixture.root)).rejects.toThrow(/artifact/i);

    expect(await treeSnapshot(fixture.staging)).toEqual(before);
  });

  it.each([
    ["unknown name", async (fixture: ImportFixture) => writeFile(join(fixture.staging, "foreign"), "keep", { mode: 0o600 })],
    ["malformed upload name", async (fixture: ImportFixture) =>
      writeFile(join(fixture.staging, ".not-a-uuid.upload"), "keep", { mode: 0o600 })],
    ["upload symlink", async (fixture: ImportFixture) =>
      symlink(join(fixture.root, "native-idle.sqlite3"), join(fixture.staging, uploadName))],
    ["hard-linked upload", async (fixture: ImportFixture) => {
      const foreign = join(fixture.root, "project-a", "foreign-upload");
      await writeFile(foreign, "keep", { mode: 0o600 });
      await link(foreign, join(fixture.staging, uploadName));
    }],
    ["wrong-mode upload", async (fixture: ImportFixture) => {
      const path = join(fixture.staging, uploadName);
      await writeFile(path, "keep", { mode: 0o600 });
      await chmod(path, 0o640);
    }],
    ["verification symlink", async (fixture: ImportFixture) => {
      const verification = join(fixture.staging, verifyName);
      await mkdir(verification, { mode: 0o700 });
      await symlink(join(fixture.root, "native-idle.sqlite3"), join(verification, "HEAD"));
    }],
    ["hard-linked verification file", async (fixture: ImportFixture) => {
      const verification = join(fixture.staging, verifyName);
      await mkdir(verification, { mode: 0o700 });
      const foreign = join(fixture.root, "project-a", "foreign-verify");
      await writeFile(foreign, "keep", { mode: 0o600 });
      await link(foreign, join(verification, "HEAD"));
    }]
  ] as const)("rejects a %s byte-identically instead of cleaning it", async (_label, arrange) => {
    const fixture = await intentFixture();
    await arrange(fixture);
    const databaseBefore = await readFile(join(fixture.root, "native-idle.sqlite3"));
    const stagingBefore = await treeSnapshot(fixture.staging);

    await expect(inspectNativeGitBundleState(fixture.root)).rejects.toThrow(/root import|staging|artifact/i);
    expect(await treeSnapshot(fixture.staging)).toEqual(stagingBefore);
    await expect(initializeNativeGitBundleState(fixture.root)).rejects.toThrow(/root import|staging|artifact/i);

    expect(await treeSnapshot(fixture.staging)).toEqual(stagingBefore);
    expect(await readFile(join(fixture.root, "native-idle.sqlite3"))).toEqual(databaseBefore);
    expect(await refValue(join(fixture.root, "project-a", "root.git"), "refs/heads/main")).toBeUndefined();
  });
});

async function intentFixture(): Promise<ImportFixture> {
  const fixture = await preparedFixture();
  const claimed = claimNativeProjectRootImport(fixture.state, generationId, "host-a", intentInput);
  const staging = join(fixture.root, "project-a", ".dim-root-import");
  await mkdir(staging, { mode: 0o700 });
  await chmod(staging, 0o700);
  await fixture.state.owner.release();
  return { root: fixture.root, staging, importNonce: claimed.importNonce };
}

async function preparedFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-reconcile-"));
  roots.push(root);
  const state = await initializeNativeGitBundleState(root);
  bindExactActivation(state, generationId, activationTokenSha256(Buffer.alloc(32, 61).toString("base64url")));
  await executeNativeProjectPreparation({
    database: state.database,
    stateDirectory: root,
    runtimeConfig: { storageRoot: root, gitExecutable: "/usr/bin/git", gitVersion: "2.43.0" },
    generationId,
    ownerHostId: "host-a",
    input: project
  });
  return { root, state };
}

async function createVerificationTree(path: string): Promise<void> {
  await mkdir(join(path, "objects"), { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await chmod(join(path, "objects"), 0o700);
  await writeFile(join(path, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    const metadata = await lstat(path, { bigint: true });
    const kind = metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" : "file";
    entries.push({
      path: relative,
      kind,
      mode: metadata.mode,
      owner: metadata.uid,
      links: metadata.nlink,
      bytes: kind === "file" ? await readFile(path) : kind === "symlink" ? await readlink(path) : null
    });
    if (kind === "directory") {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), join(relative, entry));
    }
  }
  await visit(root, ".");
  return entries;
}

type ImportFixture = { readonly root: string; readonly staging: string; readonly importNonce: string };
type TreeEntry = {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: bigint;
  readonly owner: bigint;
  readonly links: bigint;
  readonly bytes: Buffer | string | null;
};
