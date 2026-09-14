import { chmod, chown, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const filesystemModule = "../../project/.dim/qemu-service-filesystem.mjs";
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
});
