import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeHostPrivateRoot, type NativeHostPrivateRootIdentity } from "../../../../packages/host/plugins/execution-worker/src/private-root.js";
import { assignment, grant } from "../../../contracts/ci/executionFixture.js";
import { ExecutorRunner } from "./sysboxFixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary private work root", () => {
  it.skipIf(process.geteuid?.() === 0)("retains the ownership marker when child removal fails and permits a safe retry", async () => {
    const journal = await temporaryPrivateRoots();
    const root = journal.privateRoot({ schemaVersion: 1, state: "planned", rootId: "96000000-0000-4000-8000-000000000001" });
    const claimId = "20000000-0000-4000-8000-000000000001";
    await root.create(claimId);
    const blocked = join(root.path, "blocked"), marker = join(root.path, ".dim-native-ordinary-owner.json");
    await mkdir(blocked); await writeFile(join(blocked, "retain"), "retain"); await chmod(blocked, 0o500);
    const markerBytes = await readFile(marker);
    try {
      expect(await root.cleanup(claimId)).toBe(false);
      expect(await readFile(marker)).toEqual(markerBytes);
    } finally { await chmod(blocked, 0o700); }
    expect(await root.cleanup(claimId)).toBe(true);
  });

  it("never invokes privileged cleanup for an unmarked root or another claim", async () => {
    const journal = await temporaryPrivateRoots(), claim = grant(assignment()), runner = new ExecutorRunner();
    const root = journal.privateRoot({ schemaVersion: 1, state: "planned", rootId: "97000000-0000-4000-8000-000000000001" });
    await root.create(claim.executionId);
    expect(await root.cleanup("different-claim", { runner, grant: claim })).toBe(false);
    await rm(join(root.path, ".dim-native-ordinary-owner.json"));
    expect(await root.cleanup(claim.executionId, { runner, grant: claim })).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it("recovers empty identity-bound staging after marker removal is interrupted", async () => {
    const journal = await temporaryPrivateRoots();
    const root = journal.privateRoot({ schemaVersion: 1, state: "planned", rootId: "99000000-0000-4000-8000-000000000001" });
    const claimId = "20000000-0000-4000-8000-000000000001";
    await root.create(claimId); await writeFile(join(root.path, "candidate"), "data");
    expect(await root.cleanup(claimId, undefined, { async beforeStagingRemoval() { throw new Error("rmdir interrupted"); } })).toBe(false);
    await expect(lstat(root.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root.stagingPath)).toEqual([]);
    expect(await journal.privateRoot(root.identity).cleanup(claimId)).toBe(true);
    await expect(lstat(root.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replaced empty staging even after an interrupted final removal", async () => {
    const journal = await temporaryPrivateRoots();
    const root = journal.privateRoot({ schemaVersion: 1, state: "planned", rootId: "9a000000-0000-4000-8000-000000000001" });
    const claimId = "20000000-0000-4000-8000-000000000001";
    await root.create(claimId);
    expect(await root.cleanup(claimId, undefined, { async beforeStagingRemoval() { throw new Error("rmdir interrupted"); } })).toBe(false);
    await rename(root.stagingPath, `${root.stagingPath}.retained`);
    await mkdir(root.stagingPath, { mode: 0o700 });
    expect(await journal.privateRoot(root.identity).cleanup(claimId)).toBe(false);
    expect((await lstat(root.stagingPath)).isDirectory()).toBe(true);
  });

  it("removes only the exact identity-bound owned root", async () => {
    // Given
    const journal = await temporaryPrivateRoots();
    const identity = {
      schemaVersion: 1,
      state: "planned",
      rootId: "91000000-0000-4000-8000-000000000001"
    } as const;
    const privateRoot = journal.privateRoot(identity);
    const path = await privateRoot.create("20000000-0000-4000-8000-000000000001");
    await writeFile(join(path, "candidate-data"), "untrusted\n");

    // When
    const cleaned = await privateRoot.cleanup("20000000-0000-4000-8000-000000000001");

    // Then
    expect(cleaned).toBe(true);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["partial", "foreign", "mismatched", "symlink", "permissive", "hard-linked-marker"] as const)(
    "fences a %s root without deleting it",
    async (variant) => {
      // Given
      const journal = await temporaryPrivateRoots();
      const identity = {
        schemaVersion: 1,
        state: "planned",
        rootId: `92000000-0000-4000-8000-00000000000${String(roots.length)}`
      } as const;
      const privateRoot = journal.privateRoot(identity);
      let path: string;
      if (variant === "partial" || variant === "foreign") {
        path = privateRoot.path;
        await mkdir(path, { mode: 0o700 });
        if (variant === "foreign") await writeFile(join(path, "foreign"), "retain\n");
      } else if (variant === "symlink") {
        const target = await mkdtemp(join(tmpdir(), "dim-native-root-foreign-"));
        roots.push(target);
        await writeFile(join(target, "foreign"), "retain\n");
        path = privateRoot.path;
        await symlink(target, path);
      } else {
        path = await privateRoot.create("20000000-0000-4000-8000-000000000001");
        if (variant === "permissive") {
          await chmod(path, 0o755);
        } else if (variant === "hard-linked-marker") {
          const marker = (await readdir(path))[0];
          if (marker === undefined) throw new Error("private root marker is missing");
          await link(join(path, marker), join(dirname(path), "linked-marker"));
        } else {
          const marker = (await readdir(path))[0];
          if (marker === undefined) throw new Error("private root marker is missing");
          const record = JSON.parse(await readFile(join(path, marker), "utf8"));
          await writeFile(join(path, marker), JSON.stringify({ ...record, claimId: "foreign-claim" }), { mode: 0o600 });
        }
      }

      // When
      const cleaned = await privateRoot.cleanup("20000000-0000-4000-8000-000000000001");

      // Then
      expect(cleaned).toBe(false);
      expect((await lstat(path)).isSymbolicLink()).toBe(variant === "symlink");
      if (variant === "foreign") expect(await readFile(join(path, "foreign"), "utf8")).toBe("retain\n");
    }
  );

  it("fences a replacement root even when its marker bytes were copied", async () => {
    // Given
    const journal = await temporaryPrivateRoots();
    const planned = {
      schemaVersion: 1,
      state: "planned",
      rootId: "94000000-0000-4000-8000-000000000001"
    } as const;
    const createdRoot = journal.privateRoot(planned);
    const path = await createdRoot.create("20000000-0000-4000-8000-000000000001");
    const identity = createdRoot.identity;
    const marker = (await readdir(path))[0];
    if (marker === undefined) throw new Error("private root marker is missing");
    const markerBytes = await readFile(join(path, marker));
    const retainedPath = join(dirname(path), "retained-original");
    await rename(path, retainedPath);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, marker), markerBytes, { mode: 0o600 });
    const originalIdentity = await lstat(retainedPath, { bigint: true });
    const replacementIdentity = await lstat(path, { bigint: true });
    expect(originalIdentity.ino).not.toBe(replacementIdentity.ino);
    expect({ device: originalIdentity.dev, inode: originalIdentity.ino })
      .not.toEqual({ device: replacementIdentity.dev, inode: replacementIdentity.ino });

    // When
    const cleaned = await journal.privateRoot(identity).cleanup("20000000-0000-4000-8000-000000000001");

    // Then
    expect(cleaned).toBe(false);
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it.each(["foreign", "symlink", "permissive", "hard-linked-marker"] as const)(
    "fences %s staging residue without deleting it",
    async (variant) => {
      // Given
      const journal = await temporaryPrivateRoots();
      const privateRoot = journal.privateRoot({
        schemaVersion: 1,
        state: "planned",
        rootId: "95000000-0000-4000-8000-000000000001"
      });
      if (variant === "symlink") {
        const target = await mkdtemp(join(tmpdir(), "dim-native-root-foreign-"));
        roots.push(target);
        await writeFile(join(target, "retain"), "foreign\n");
        await symlink(target, privateRoot.stagingPath);
      } else {
        await mkdir(privateRoot.stagingPath, { mode: variant === "permissive" ? 0o755 : 0o700 });
        if (variant === "hard-linked-marker") {
          const marker = join(dirname(privateRoot.stagingPath), "foreign-marker");
          await writeFile(marker, "foreign\n", { mode: 0o600 });
          await link(marker, join(privateRoot.stagingPath, ".dim-native-ordinary-owner.json"));
        } else {
          await writeFile(join(privateRoot.stagingPath, "retain"), "foreign\n");
        }
      }

      // When
      const cleaned = await privateRoot.cleanup("20000000-0000-4000-8000-000000000001");

      // Then
      expect(cleaned).toBe(false);
      expect((await lstat(privateRoot.stagingPath)).isSymbolicLink()).toBe(variant === "symlink");
    }
  );

  it("rejects a caller-supplied path token without touching foreign state", async () => {
    // Given
    const journal = await temporaryPrivateRoots();
    const foreign = await mkdtemp(join(tmpdir(), "dim-native-root-foreign-"));
    roots.push(foreign);
    await writeFile(join(foreign, "retain"), "foreign\n");

    // When / Then
    expect(() => journal.privateRoot({
      schemaVersion: 1,
      state: "planned",
      rootId: `../../${foreign.slice(foreign.lastIndexOf("/") + 1)}`
    })).toThrow(/identity is invalid/);
    expect(await readFile(join(foreign, "retain"), "utf8")).toBe("foreign\n");
  });
});

async function temporaryPrivateRoots() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  return { privateRoot: (identity: NativeHostPrivateRootIdentity) => new NativeHostPrivateRoot(root, identity) };
}
