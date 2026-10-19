import { chmod, link, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { tryAcquireKernelGuard } from "../../../../packages/control-plane/core/src/lock.js";

it("standalone guard serializes contenders on one permanent inode and releases idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-cp-guard-"));
  try {
    const file = join(root, "service.guard"), first = await tryAcquireKernelGuard(file);
    expect(first).toBeDefined();
    const inode = (await stat(file)).ino;
    try { expect(await tryAcquireKernelGuard(file)).toBeUndefined(); }
    finally { await first?.release(); }
    await first?.release();
    const next = await tryAcquireKernelGuard(file, { timeoutMilliseconds: 100 });
    expect(next).toBeDefined(); await next?.release();
    expect((await stat(file)).ino).toBe(inode);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("standalone guard rejects symlinks, hardlinks and permissive files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-cp-guard-private-"));
  try {
    const target = join(root, "target"), file = join(root, "guard");
    await writeFile(target, "", { mode: 0o600 }); await symlink(target, file);
    await expect(tryAcquireKernelGuard(file)).rejects.toThrow(); await rm(file);
    await link(target, file); await expect(tryAcquireKernelGuard(file)).rejects.toThrow(/private user-owned/); await rm(file);
    await chmod(target, 0o644); await expect(tryAcquireKernelGuard(target)).rejects.toThrow(/private user-owned/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
