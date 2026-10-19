import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeHostPrivateRoot, type NativeHostPrivateRootIdentity } from "../../../../packages/host/plugins/ci-worker/src/private-root.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary private work root", () => {
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
