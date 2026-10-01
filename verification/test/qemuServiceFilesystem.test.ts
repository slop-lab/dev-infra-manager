import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const filesystemModule = "../../.dim/qemu-service-filesystem.mjs";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-qemu-filesystem-test-"));
  roots.push(root);
  await chmod(root, 0o755);
  return {
    serviceDirectory: root,
    pidPath: join(root, "service.pid"),
    ownerPath: join(root, "service-owner.json"),
    socketPath: join(root, "service.sock"),
    leasePath: join(root, ".service.sock.lease"),
    runsRoot: join(root, "runs")
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU service filesystem namespace", () => {
  it("rejects a service directory whose mode is not exactly 0755", async () => {
    const paths = await fixture();
    await chmod(paths.serviceDirectory, 0o700);
    const { prepareServiceFilesystem } = await import(filesystemModule);
    await expect(prepareServiceFilesystem(paths)).rejects.toThrow(/mode 0755/);
  });

  it("rejects a service directory with special mode bits", async () => {
    const paths = await fixture();
    await chmod(paths.serviceDirectory, 0o1755);
    const { prepareServiceFilesystem } = await import(filesystemModule);
    await expect(prepareServiceFilesystem(paths)).rejects.toThrow(/mode 0755/);
  });

  it("rejects a symlink service directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "dim-qemu-filesystem-link-test-"));
    roots.push(parent);
    const target = join(parent, "target");
    const serviceDirectory = join(parent, "service");
    await mkdir(target, { mode: 0o755 });
    await symlink(target, serviceDirectory);
    const paths = {
      serviceDirectory, pidPath: join(serviceDirectory, "service.pid"),
      ownerPath: join(serviceDirectory, "service-owner.json"), socketPath: join(serviceDirectory, "service.sock"),
      leasePath: join(serviceDirectory, ".service.sock.lease"), runsRoot: join(serviceDirectory, "runs")
    };
    const { prepareServiceFilesystem } = await import(filesystemModule);
    await expect(prepareServiceFilesystem(paths)).rejects.toThrow();
  });

  it.each([[1, 0], [0, 1]] as const)("rejects service-directory ownership %i:%i", async (uid, gid) => {
    const paths = await fixture();
    await chown(paths.serviceDirectory, uid, gid);
    const { prepareServiceFilesystem } = await import(filesystemModule);
    await expect(prepareServiceFilesystem(paths)).rejects.toThrow(/root:root/);
  });

  it.each(["pidPath", "ownerPath", "socketPath", "leasePath"] as const)(
    "rejects an existing or dangling %s while allowing stale runs",
    async (pathName) => {
      const paths = await fixture();
      await mkdir(paths.runsRoot, { mode: 0o700 });
      await symlink(join(paths.serviceDirectory, "missing"), paths[pathName]);
      const { prepareServiceFilesystem } = await import(filesystemModule);
      await expect(prepareServiceFilesystem(paths)).rejects.toThrow(/already exists/);
      await expect(lstat(paths.runsRoot)).resolves.toBeDefined();
    }
  );
});

describe("QEMU staged runs activation", () => {
  it("preserves stale runs until prepared state is activated", async () => {
    const paths = await fixture();
    await mkdir(paths.runsRoot, { mode: 0o700 });
    await writeFile(join(paths.runsRoot, "sentinel"), "stale");
    const { activatePreparedRuns, prepareServiceFilesystem } = await import(filesystemModule);
    const preparedRunsRoot = await prepareServiceFilesystem(paths);
    const prepared = await lstat(preparedRunsRoot, { bigint: true });
    expect.soft({ uid: prepared.uid, gid: prepared.gid }).toEqual({ uid: 0n, gid: 0n });
    expect(prepared.mode & 0o7777n).toBe(0o700n);
    await expect(lstat(join(paths.runsRoot, "sentinel"))).resolves.toBeDefined();
    await activatePreparedRuns(paths.runsRoot, preparedRunsRoot);
    await expect(lstat(join(paths.runsRoot, "sentinel"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(paths.runsRoot, { bigint: true })).mode & 0o7777n).toBe(0o700n);
  });

  it("discards only unactivated prepared state", async () => {
    const paths = await fixture();
    await mkdir(paths.runsRoot, { mode: 0o700 });
    await writeFile(join(paths.runsRoot, "sentinel"), "stale");
    const { discardPreparedRuns, prepareServiceFilesystem } = await import(filesystemModule);
    const preparedRunsRoot = await prepareServiceFilesystem(paths);
    await discardPreparedRuns(preparedRunsRoot);
    await expect(lstat(preparedRunsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(paths.runsRoot, "sentinel"))).resolves.toBeDefined();
  });

  it("restores stale runs when prepared activation fails", async () => {
    const paths = await fixture();
    await mkdir(paths.runsRoot, { mode: 0o700 });
    await writeFile(join(paths.runsRoot, "sentinel"), "stale");
    const { activatePreparedRuns, discardPreparedRuns, prepareServiceFilesystem } = await import(filesystemModule);
    const preparedRunsRoot = await prepareServiceFilesystem(paths);
    let renameCount = 0;
    const operations = {
      rename: async (source: string, destination: string) => {
        renameCount += 1;
        if (renameCount === 2) throw Object.assign(new Error("activation failed"), { code: "EIO" });
        await rename(source, destination);
      },
      rm,
    };

    await expect(activatePreparedRuns(paths.runsRoot, preparedRunsRoot, operations)).rejects.toThrow("activation failed");
    await expect(readFile(join(paths.runsRoot, "sentinel"), "utf8")).resolves.toBe("stale");
    await discardPreparedRuns(preparedRunsRoot);
  });

  it("keeps fresh canonical runs and partial old evidence when post-commit cleanup fails", async () => {
    const paths = await fixture();
    await mkdir(paths.runsRoot, { mode: 0o700 });
    await writeFile(join(paths.runsRoot, "sentinel"), "stale");
    await writeFile(join(paths.runsRoot, "survivor"), "old evidence");
    const { activatePreparedRuns, prepareServiceFilesystem } = await import(filesystemModule);
    const preparedRunsRoot = await prepareServiceFilesystem(paths);
    await writeFile(join(preparedRunsRoot, "new"), "prepared");
    const operations = {
      rename,
      rm: async (target: string, options: { readonly recursive: boolean }) => {
        if (target.includes(".replaced-")) {
          await rm(join(target, "sentinel"));
          throw new Error("replaced cleanup failed");
        }
        await rm(target, options);
      },
    };

    await expect(activatePreparedRuns(paths.runsRoot, preparedRunsRoot, operations)).rejects.toThrow(
      "replaced cleanup failed",
    );
    expect(await readFile(join(paths.runsRoot, "new"), "utf8")).toBe("prepared");
    await expect(lstat(join(paths.runsRoot, "sentinel"))).rejects.toMatchObject({ code: "ENOENT" });
    const quarantines = (await readdir(paths.serviceDirectory)).filter((name) => name.startsWith("runs.replaced-"));
    expect.soft(quarantines).toHaveLength(1);
    expect(await readFile(join(paths.serviceDirectory, quarantines[0] ?? "missing", "survivor"), "utf8")).toBe("old evidence");
  });

  it("reports activation before a pre-commit stale-tree restoration failure", async () => {
    const paths = await fixture();
    await mkdir(paths.runsRoot, { mode: 0o700 });
    await writeFile(join(paths.runsRoot, "sentinel"), "stale");
    const { activatePreparedRuns, prepareServiceFilesystem } = await import(filesystemModule);
    const preparedRunsRoot = await prepareServiceFilesystem(paths);
    await writeFile(join(preparedRunsRoot, "prepared"), "fresh");
    let renameCount = 0;
    const operations = {
      rename: async (source: string, destination: string) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("activation failed");
        if (renameCount === 3) throw new Error("restore failed");
        await rename(source, destination);
      },
      rm,
    };

    const result = await Promise.allSettled([activatePreparedRuns(paths.runsRoot, preparedRunsRoot, operations)]);
    expect(result).toMatchObject([{ status: "rejected", reason: {
      errors: [{ message: "activation failed" }, { message: "restore failed" }],
    } }]);
    expect.soft(await readFile(join(preparedRunsRoot, "prepared"), "utf8")).toBe("fresh");
    const quarantines = (await readdir(paths.serviceDirectory)).filter((name) => name.startsWith("runs.replaced-"));
    expect.soft(quarantines).toHaveLength(1);
    expect(await readFile(join(paths.serviceDirectory, quarantines[0] ?? "missing", "sentinel"), "utf8")).toBe("stale");
  });
});